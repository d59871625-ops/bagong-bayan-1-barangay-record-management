<?php

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/registration-application-storage.php";

header("Cache-Control: no-store");

function respond(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data);
    exit;
}

if (($_SERVER["REQUEST_METHOD"] ?? "") !== "POST") {
    header("Allow: POST, OPTIONS");
    respond(405, [
        "success" => false,
        "message" => "Method not allowed."
    ]);
}

$rawInput = file_get_contents("php://input");
if ($rawInput === false || strlen($rawInput) > 1200000) {
    respond(413, [
        "success" => false,
        "message" => "The application is too large to submit."
    ]);
}

$input = json_decode($rawInput, true);
if (!is_array($input) || !is_array($input["data"] ?? null) || !is_array($input["files"] ?? null)) {
    respond(400, [
        "success" => false,
        "message" => "Invalid application data."
    ]);
}

$submissionKey = trim((string) ($input["submission_key"] ?? ""));
if (!preg_match('/^REG-\d{4}-[A-F0-9]{16}$/', $submissionKey)) {
    respond(422, [
        "success" => false,
        "message" => "A valid application submission key is required."
    ]);
}

$data = $input["data"];
$fieldLimits = [
    "firstName" => 100,
    "middleName" => 100,
    "lastName" => 100,
    "suffix" => 30,
    "birthDate" => 10,
    "placeOfBirth" => 190,
    "sex" => 30,
    "civilStatus" => 30,
    "nationality" => 80,
    "mobileNumber" => 40,
    "emailAddress" => 190,
    "houseBlockLot" => 190,
    "streetPurok" => 190,
    "barangay" => 100,
    "municipalityCity" => 100,
    "province" => 100,
    "stayDuration" => 100,
    "newResident" => 5,
    "previousAddress" => 255,
    "previousBarangay" => 100,
    "previousMunicipalityCity" => 100,
    "dateOfTransfer" => 10,
    "reasonForMoving" => 500,
    "householdHead" => 5,
    "householdHeadName" => 190,
    "householdMembers" => 10,
    "relationshipToHead" => 100,
    "validIdType" => 100,
    "idNumber" => 100,
    "proofOfResidence" => 190
];

$validatedData = [];
foreach ($fieldLimits as $field => $limit) {
    $value = $data[$field] ?? "";
    if ($field === "proofOfResidence" && is_array($value)) {
        $allowedProofTypes = ["Lease/Rental Agreement", "Utility Bill", "Property/House Document", "Certification from Property Owner", "Other"];
        $value = array_values(array_unique(array_filter($value, static fn($proof) => is_string($proof) && in_array($proof, $allowedProofTypes, true))));
        $validatedData[$field] = $value;
        continue;
    }
    if (!is_string($value) && !is_numeric($value)) {
        respond(422, [
            "success" => false,
            "message" => "One or more application fields are invalid."
        ]);
    }

    $value = trim((string) $value);
    $characterCount = function_exists("mb_strlen") ? mb_strlen($value, "UTF-8") : strlen($value);
    if ($characterCount > $limit) {
        respond(422, [
            "success" => false,
            "message" => "One or more application fields exceed the allowed length."
        ]);
    }
    $validatedData[$field] = $value;
}

foreach (["firstName", "lastName", "birthDate", "placeOfBirth", "sex", "civilStatus", "nationality", "mobileNumber", "streetPurok", "stayDuration", "householdHeadName", "householdMembers", "relationshipToHead", "validIdType", "idNumber"] as $requiredField) {
    if ($validatedData[$requiredField] === "") {
        respond(422, [
            "success" => false,
            "message" => "Complete all required application fields."
        ]);
    }
}
if ($validatedData["newResident"] === "yes") {
    foreach (["previousAddress", "previousBarangay", "previousMunicipalityCity", "dateOfTransfer", "reasonForMoving"] as $requiredField) {
        if ($validatedData[$requiredField] === "") {
            respond(422, [
                "success" => false,
                "message" => "Complete all required residency information."
            ]);
        }
    }
}

$date = DateTime::createFromFormat("!Y-m-d", $validatedData["birthDate"]);
if (!$date || $date->format("Y-m-d") !== $validatedData["birthDate"]) {
    respond(422, [
        "success" => false,
        "message" => "Enter a valid date of birth."
    ]);
}

$email = strtolower($validatedData["emailAddress"]);
if ($email !== "" && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    respond(422, [
        "success" => false,
        "message" => "Enter a valid email address."
    ]);
}

$validateEvidence = static function ($evidence): string {
    if (!is_array($evidence)) {
        throw new InvalidArgumentException("Upload both a valid ID and proof of residence.");
    }

    $fileName = trim((string) ($evidence["fileName"] ?? ""));
    $mediaType = strtolower(trim((string) ($evidence["mediaType"] ?? "")));
    $dataUrl = (string) ($evidence["dataUrl"] ?? "");
    if ($fileName === "" || strlen($fileName) > 255 || !in_array($mediaType, ["image/jpeg", "image/png", "image/webp", "application/pdf"], true)) {
        throw new InvalidArgumentException("An uploaded proof has an unsupported file type or name.");
    }

    if (!preg_match('/^data:' . preg_quote($mediaType, '/') . ';base64,([A-Za-z0-9+\/=]+)$/', $dataUrl, $matches)) {
        throw new InvalidArgumentException("An uploaded proof could not be verified.");
    }

    $binary = base64_decode($matches[1], true);
    if ($binary === false || strlen($binary) > 400 * 1024) {
        throw new InvalidArgumentException("An uploaded proof is too large or invalid.");
    }

    $validSignature = match ($mediaType) {
        "image/jpeg" => str_starts_with($binary, "\xFF\xD8\xFF"),
        "image/png" => str_starts_with($binary, "\x89PNG\r\n\x1A\n"),
        "image/webp" => strlen($binary) >= 12 && substr($binary, 0, 4) === "RIFF" && substr($binary, 8, 4) === "WEBP",
        "application/pdf" => str_starts_with($binary, "%PDF-"),
        default => false
    };
    if (!$validSignature) {
        throw new InvalidArgumentException("An uploaded proof does not match its file type.");
    }

    return json_encode([
        "fileName" => basename($fileName),
        "mediaType" => $mediaType,
        "dataUrl" => $dataUrl
    ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
};

try {
    $validId = $validateEvidence($input["files"]["validId"] ?? null);
    $proofOfResidence = $validateEvidence($input["files"]["proofOfResidence"] ?? null);
} catch (InvalidArgumentException $error) {
    respond(422, [
        "success" => false,
        "message" => $error->getMessage()
    ]);
} catch (JsonException $error) {
    respond(422, [
        "success" => false,
        "message" => "An uploaded proof could not be saved."
    ]);
}

try {
    ensureRegistrationApplicationDetailsTable($pdo);
    $applicationDataJson = json_encode(
        $validatedData,
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR
    );
    $pdo->beginTransaction();

    $existingStmt = $pdo->prepare("
        SELECT registration_id, application_data, valid_id, proof_of_residence
        FROM registration_application_details
        WHERE submission_key = ?
        LIMIT 1
    ");
    $existingStmt->execute([$submissionKey]);
    $existingSubmission = $existingStmt->fetch(PDO::FETCH_ASSOC);
    if ($existingSubmission) {
        $samePayload = hash_equals(
            hash("sha256", (string) $existingSubmission["application_data"]),
            hash("sha256", $applicationDataJson)
        ) && hash_equals(
            hash("sha256", (string) $existingSubmission["valid_id"]),
            hash("sha256", $validId)
        ) && hash_equals(
            hash("sha256", (string) $existingSubmission["proof_of_residence"]),
            hash("sha256", $proofOfResidence)
        );
        if (!$samePayload) {
            $pdo->rollBack();
            respond(409, [
                "success" => false,
                "message" => "This submission key already belongs to a different application."
            ]);
        }
        $pdo->commit();
        respond(200, [
            "success" => true,
            "message" => "Registration application received.",
            "data" => ["id" => (int) $existingSubmission["registration_id"]]
        ]);
    }

    if ($email !== "") {
        $existingUserStmt = $pdo->prepare("
            SELECT id FROM users
            WHERE email = ?
            LIMIT 1
        ");
        $existingUserStmt->execute([$email]);
        if ($existingUserStmt->fetchColumn() !== false) {
            $pdo->rollBack();
            respond(409, [
                "success" => false,
                "message" => "An account with this email already exists."
            ]);
        }

        $duplicateStmt = $pdo->prepare("
            SELECT id FROM registration_requests
            WHERE email = ? AND status = 'pending'
            LIMIT 1
        ");
        $duplicateStmt->execute([$email]);
        if ($duplicateStmt->fetchColumn() !== false) {
            $pdo->rollBack();
            respond(409, [
                "success" => false,
                "message" => "A registration request with this email is already pending."
            ]);
        }
    }

    $passwordHash = password_hash(bin2hex(random_bytes(32)), PASSWORD_DEFAULT);
    $insert = $pdo->prepare("
        INSERT INTO registration_requests (
            first_name, middle_name, last_name, suffix, email, password_hash,
            date_of_birth, sex, civil_status, contact_number, house_no_street,
            purok, barangay, city_municipality, province
        ) VALUES (
            :first_name, :middle_name, :last_name, :suffix, :email, :password_hash,
            :date_of_birth, :sex, :civil_status, :contact_number, :house_no_street,
            :purok, :barangay, :city_municipality, :province
        )
    ");
    $insert->execute([
        ":first_name" => $validatedData["firstName"],
        ":middle_name" => $validatedData["middleName"] ?: null,
        ":last_name" => $validatedData["lastName"],
        ":suffix" => $validatedData["suffix"] ?: null,
        ":email" => $email ?: null,
        ":password_hash" => $passwordHash,
        ":date_of_birth" => $validatedData["birthDate"],
        ":sex" => $validatedData["sex"] ?: null,
        ":civil_status" => $validatedData["civilStatus"] ?: null,
        ":contact_number" => $validatedData["mobileNumber"],
        ":house_no_street" => $validatedData["houseBlockLot"] ?: null,
        ":purok" => $validatedData["streetPurok"],
        ":barangay" => $validatedData["barangay"] ?: null,
        ":city_municipality" => $validatedData["municipalityCity"] ?: null,
        ":province" => $validatedData["province"] ?: null
    ]);
    $registrationId = (int) $pdo->lastInsertId();

    $details = $pdo->prepare("
        INSERT INTO registration_application_details (
            registration_id, submission_key, application_data, valid_id, proof_of_residence
        ) VALUES (?, ?, ?, ?, ?)
    ");
    $details->execute([
        $registrationId,
        $submissionKey,
        $applicationDataJson,
        $validId,
        $proofOfResidence
    ]);
    $pdo->commit();

    respond(201, [
        "success" => true,
        "message" => "Registration application received.",
        "data" => ["id" => $registrationId]
    ]);
} catch (Throwable $error) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log("Public resident registration submission failed: " . $error->getMessage());
    respond(500, [
        "success" => false,
        "message" => "The application could not be saved to the barangay database. Please try again."
    ]);
}
