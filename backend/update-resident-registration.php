<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/registration-application-storage.php";

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function normalizeRegistrationName(string $value): string
{
    $value = function_exists("mb_strtolower") ? mb_strtolower($value, "UTF-8") : strtolower($value);
    return preg_replace('/[^\p{L}\p{N}]+/u', '', $value) ?? "";
}

function validRegistrationEvidence($evidence): ?string
{
    if (!is_array($evidence)) return null;
    $fileName = trim((string) ($evidence["fileName"] ?? ""));
    $mediaType = strtolower(trim((string) ($evidence["mediaType"] ?? "")));
    $dataUrl = (string) ($evidence["dataUrl"] ?? "");
    if ($fileName === "" || strlen($fileName) > 255
        || !in_array($mediaType, ["image/jpeg", "image/png", "image/webp", "application/pdf"], true)
        || !preg_match('/^data:' . preg_quote($mediaType, '/') . ';base64,([A-Za-z0-9+\/=]+)$/', $dataUrl, $matches)) {
        throw new InvalidArgumentException("An uploaded registration proof is invalid.");
    }
    $binary = base64_decode($matches[1], true);
    if ($binary === false || strlen($binary) > 400 * 1024) {
        throw new InvalidArgumentException("An uploaded registration proof is too large or invalid.");
    }
    $validSignature = match ($mediaType) {
        "image/jpeg" => str_starts_with($binary, "\xFF\xD8\xFF"),
        "image/png" => str_starts_with($binary, "\x89PNG\r\n\x1A\n"),
        "image/webp" => strlen($binary) >= 12 && substr($binary, 0, 4) === "RIFF" && substr($binary, 8, 4) === "WEBP",
        "application/pdf" => str_starts_with($binary, "%PDF-"),
        default => false,
    };
    if (!$validSignature) throw new InvalidArgumentException("An uploaded registration proof does not match its file type.");
    return json_encode([
        "fileName" => basename($fileName),
        "mediaType" => $mediaType,
        "dataUrl" => $dataUrl,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
}

if (($_SERVER["REQUEST_METHOD"] ?? "") !== "POST") {
    header("Allow: POST, OPTIONS");
    respond(405, ["success" => false, "message" => "Method not allowed."]);
}
$rawInput = file_get_contents("php://input");
if ($rawInput === false || strlen($rawInput) > 1200000) respond(413, ["success" => false, "message" => "The application is too large to update."]);
$input = json_decode($rawInput, true);
$data = is_array($input) ? ($input["data"] ?? null) : null;
$name = is_array($input) ? ($input["name"] ?? null) : null;
$files = is_array($input) ? ($input["files"] ?? null) : null;
$reference = is_array($input) ? strtoupper(trim((string) ($input["reference"] ?? ""))) : "";
if (!is_array($data) || !is_array($name) || !is_array($files)
    || !preg_match('/^(?:DB-)?REG-([1-9][0-9]*)$/', $reference, $matches)) {
    respond(422, ["success" => false, "message" => "A valid application reference, applicant name, form, and proof files are required."]);
}
$registrationId = (int) $matches[1];
$inputName = implode(" ", array_filter([
    $name["first_name"] ?? $name["firstName"] ?? "",
    $name["middle_name"] ?? $name["middleName"] ?? "",
    $name["last_name"] ?? $name["lastName"] ?? "",
    $name["suffix"] ?? "",
], static fn($part) => is_string($part) && trim($part) !== ""));

$fieldLimits = [
    "firstName" => 100, "middleName" => 100, "lastName" => 100, "suffix" => 30,
    "birthDate" => 10, "placeOfBirth" => 190, "sex" => 30, "civilStatus" => 30,
    "nationality" => 80, "mobileNumber" => 40, "emailAddress" => 190,
    "houseBlockLot" => 190, "streetPurok" => 190, "barangay" => 100,
    "municipalityCity" => 100, "province" => 100, "stayDuration" => 100,
    "newResident" => 5, "previousAddress" => 255, "previousBarangay" => 100,
    "previousMunicipalityCity" => 100, "dateOfTransfer" => 10, "reasonForMoving" => 500,
    "householdHead" => 5, "householdHeadName" => 190, "householdMembers" => 10,
    "relationshipToHead" => 100, "validIdType" => 100, "idNumber" => 100,
];
$validatedData = [];
foreach ($fieldLimits as $field => $limit) {
    $value = $data[$field] ?? "";
    if (!is_string($value) && !is_numeric($value)) respond(422, ["success" => false, "message" => "One or more application fields are invalid."]);
    $value = trim((string) $value);
    $length = function_exists("mb_strlen") ? mb_strlen($value, "UTF-8") : strlen($value);
    if ($length > $limit) respond(422, ["success" => false, "message" => "One or more application fields exceed the allowed length."]);
    $validatedData[$field] = $value;
}
$proofTypes = ["Lease/Rental Agreement", "Utility Bill", "Property/House Document", "Certification from Property Owner", "Other"];
$proofValues = $data["proofOfResidence"] ?? [];
if (!is_array($proofValues)) $proofValues = [$proofValues];
$validatedData["proofOfResidence"] = array_values(array_unique(array_filter($proofValues,
    static fn($value) => is_string($value) && in_array($value, $proofTypes, true))));
try {
    ensureRegistrationApplicationDetailsTable($pdo);
    ensureRegistrationReferenceAccessTable($pdo);
    $pdo->beginTransaction();
    $stmt = $pdo->prepare("SELECT r.*, d.submission_key, d.application_data, d.valid_id, d.proof_of_residence
        FROM registration_requests AS r
        LEFT JOIN registration_application_details AS d ON d.registration_id = r.id
        WHERE r.id = ? LIMIT 1 FOR UPDATE");
    $stmt->execute([$registrationId]);
    $application = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$application || normalizeRegistrationName($inputName) === ""
        || !hash_equals(normalizeRegistrationName(implode(" ", array_filter([
            $application["first_name"], $application["middle_name"], $application["last_name"], $application["suffix"],
        ]))), normalizeRegistrationName($inputName))) {
        $pdo->rollBack();
        respond(404, ["success" => false, "message" => "Application reference or applicant name was not found."]);
    }
    if (strtolower((string) $application["status"]) !== "pending") {
        $pdo->rollBack();
        respond(409, ["success" => false, "message" => "Only a pending registration returned for edits can be resubmitted."]);
    }
    $existingData = json_decode((string) ($application["application_data"] ?? "{}"), true);
    if (!is_array($existingData)) $existingData = [];
    $savedData = array_replace([
        "firstName" => $application["first_name"] ?? "",
        "middleName" => $application["middle_name"] ?? "",
        "lastName" => $application["last_name"] ?? "",
        "suffix" => $application["suffix"] ?? "",
        "emailAddress" => $application["email"] ?? "",
        "birthDate" => $application["date_of_birth"] ?? "",
        "sex" => $application["sex"] ?? "",
        "civilStatus" => $application["civil_status"] ?? "",
        "mobileNumber" => $application["contact_number"] ?? "",
        "houseBlockLot" => $application["house_no_street"] ?? "",
        "streetPurok" => $application["purok"] ?? "",
        "barangay" => $application["barangay"] ?? "",
        "municipalityCity" => $application["city_municipality"] ?? "",
        "province" => $application["province"] ?? "",
    ], $existingData);
    foreach ($validatedData as $field => $value) {
        $isBlank = is_string($value) ? trim($value) === "" : (is_array($value) && $value === []);
        if (!$isBlank || !array_key_exists($field, $savedData)) {
            $savedData[$field] = $value;
        }
    }
    foreach (["firstName", "lastName", "birthDate", "placeOfBirth", "sex", "civilStatus", "nationality", "mobileNumber", "streetPurok", "stayDuration", "householdHeadName", "householdMembers", "relationshipToHead", "validIdType", "idNumber"] as $required) {
        if (trim((string) ($savedData[$required] ?? "")) === "") {
            $pdo->rollBack();
            respond(422, ["success" => false, "message" => "Complete all required registration information before resubmitting."]);
        }
    }
    if (strtolower((string) ($savedData["newResident"] ?? "")) === "yes") {
        foreach (["previousAddress", "previousBarangay", "previousMunicipalityCity", "dateOfTransfer", "reasonForMoving"] as $required) {
            if (trim((string) ($savedData[$required] ?? "")) === "") {
                $pdo->rollBack();
                respond(422, ["success" => false, "message" => "Complete all required residency information before resubmitting."]);
            }
        }
    }
    $validatedData = $savedData;
    $birthDate = DateTime::createFromFormat("!Y-m-d", $validatedData["birthDate"]);
    if (!$birthDate || $birthDate->format("Y-m-d") !== $validatedData["birthDate"]) {
        $pdo->rollBack();
        respond(422, ["success" => false, "message" => "Enter a valid date of birth."]);
    }
    $email = strtolower($validatedData["emailAddress"]);
    if ($email !== "" && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $pdo->rollBack();
        respond(422, ["success" => false, "message" => "Enter a valid email address."]);
    }
    $applicationDataJson = json_encode(array_replace($existingData, $validatedData), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    $validId = isset($files["validId"]) ? validRegistrationEvidence($files["validId"]) : null;
    $residenceProof = isset($files["proofOfResidence"]) ? validRegistrationEvidence($files["proofOfResidence"]) : null;
    $validId ??= $application["valid_id"];
    $residenceProof ??= $application["proof_of_residence"];
    if (!$validId || !$residenceProof) {
        $pdo->rollBack();
        respond(422, ["success" => false, "message" => "Both a valid ID and proof of residence must remain on the application."]);
    }
    if ($email !== "") {
        $userCheck = $pdo->prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1");
        $userCheck->execute([$email]);
        if ($userCheck->fetchColumn() !== false) {
            $pdo->rollBack();
            respond(409, ["success" => false, "message" => "This email is already linked to an account. Use an email address that is not registered yet."]);
        }
        $otherApplication = $pdo->prepare("SELECT id FROM registration_requests WHERE LOWER(email) = LOWER(?) AND id <> ? AND status = 'pending' LIMIT 1");
        $otherApplication->execute([$email, $registrationId]);
        if ($otherApplication->fetchColumn() !== false) {
            $pdo->rollBack();
            respond(409, ["success" => false, "message" => "This email is already used by another pending registration."]);
        }
    }
    $update = $pdo->prepare("UPDATE registration_requests SET
        first_name = ?, middle_name = ?, last_name = ?, suffix = ?, email = ?,
        date_of_birth = ?, sex = ?, civil_status = ?, contact_number = ?,
        house_no_street = ?, purok = ?, barangay = ?, city_municipality = ?, province = ?
        WHERE id = ? AND status = 'pending'");
    $update->execute([
        $validatedData["firstName"], $validatedData["middleName"] ?: null,
        $validatedData["lastName"], $validatedData["suffix"] ?: null,
        $email ?: null, $validatedData["birthDate"], $validatedData["sex"] ?: null,
        $validatedData["civilStatus"] ?: null, $validatedData["mobileNumber"],
        $validatedData["houseBlockLot"] ?: null, $validatedData["streetPurok"],
        $validatedData["barangay"] ?: null, $validatedData["municipalityCity"] ?: null,
        $validatedData["province"] ?: null, $registrationId,
    ]);
    $details = $pdo->prepare("INSERT INTO registration_application_details
        (registration_id, submission_key, application_data, valid_id, proof_of_residence)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            application_data = VALUES(application_data),
            valid_id = VALUES(valid_id),
            proof_of_residence = VALUES(proof_of_residence)");
    $details->execute([$registrationId, "REG-EDIT-" . $registrationId, $applicationDataJson, $validId, $residenceProof]);
    $clearNote = $pdo->prepare("UPDATE registration_reference_access SET paused_note = NULL WHERE registration_id = ?");
    $clearNote->execute([$registrationId]);
    $pdo->commit();
    respond(200, ["success" => true, "message" => "Your corrected registration was sent back to the barangay for review.", "data" => [
        "registration_id" => $registrationId,
        "status" => "Pending",
        "updated_at" => gmdate("c"),
    ]]);
} catch (InvalidArgumentException $error) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    respond(422, ["success" => false, "message" => $error->getMessage()]);
} catch (Throwable $error) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("Resident registration update failed: " . $error->getMessage());
    respond(500, ["success" => false, "message" => "The corrected application could not be saved. Please try again."]);
}
