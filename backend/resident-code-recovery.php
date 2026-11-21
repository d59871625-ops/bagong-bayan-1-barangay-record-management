<?php

require_once __DIR__ . "/vendor/autoload.php";
require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

use PHPMailer\PHPMailer\PHPMailer;

header("Cache-Control: no-store");

class RecoveryDeliveryException extends RuntimeException
{
    public int $httpStatus;

    public function __construct(string $message, int $httpStatus)
    {
        parent::__construct($message);
        $this->httpStatus = $httpStatus;
    }
}

function respond(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data);
    exit;
}

function sendRecoveryEmail(string $recipient, string $recipientName, string $subject, string $body): void
{
    $username = trim((string) backendEnv("BRGY_GMAIL_USERNAME"));
    $appPassword = preg_replace('/\s+/', '', (string) backendEnv("BRGY_GMAIL_APP_PASSWORD"));
    if ($username === "" || $appPassword === "") {
        throw new RecoveryDeliveryException("Email delivery is not configured on the backend.", 503);
    }

    try {
        $mail = new PHPMailer(true);
        $mail->isSMTP();
        $mail->Host = "smtp.gmail.com";
        $mail->SMTPAuth = true;
        $mail->Username = $username;
        $mail->Password = $appPassword;
        $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
        $mail->Port = 587;
        $mail->CharSet = "UTF-8";
        $mail->setFrom($username, trim((string) backendEnv("BRGY_GMAIL_FROM_NAME")) ?: "Barangay Bagong Bayan I");
        $mail->addAddress($recipient, $recipientName);
        $mail->Subject = $subject;
        $mail->Body = $body;
        $mail->send();
    } catch (Throwable $error) {
        error_log("Resident recovery email delivery failed.");
        throw new RecoveryDeliveryException("The email could not be sent. Check the Gmail SMTP configuration and try again.", 502);
    }
}

function sendRecoveryCodeByEmail(string $recipient, string $residentName, string $residentCode): void
{
    sendRecoveryEmail(
        $recipient,
        $residentName,
        "Your resident login code",
        "Hello {$residentName},\n\nYour new resident login code is: {$residentCode}\n\nThis replaces your previous resident login code. Keep it private. If you did not request this change, contact the barangay office."
    );
}

function sendRecoveryDeclinedNotice(string $recipient, string $residentName, string $requestId): void
{
    $safeName = trim((string) preg_replace('/[\r\n\x00-\x1F\x7F]+/u', ' ', $residentName));
    $safeName = substr($safeName, 0, 120);
    $body = "Hello {$safeName},\n\nWe're sorry, but your resident code recovery request {$requestId} was declined. No resident code was sent.";
    sendRecoveryEmail($recipient, $safeName, "Resident code recovery request update", $body);
}

function maskRecoveryDestination(string $destination): string
{
    [$localPart, $domain] = explode("@", $destination, 2);
    return substr($localPart, 0, 1) . "***@" . $domain;
}

function replaceResidentCodeFields(array $records, string $previousCode, string $newCode, array $fields, ?string $updatedAt = null): array
{
    foreach ($records as $index => $record) {
        if (!is_array($record)) continue;
        $matched = false;
        foreach ($fields as $field) {
            $value = $record[$field] ?? null;
            if (is_string($value) && strtoupper(trim($value)) === $previousCode) {
                $records[$index][$field] = $newCode;
                $matched = true;
            }
        }
        if ($matched && $updatedAt !== null) {
            $records[$index]["updatedAt"] = $updatedAt;
        }
    }

    return $records;
}

function loadAppStateRecordsForUpdate(PDO $pdo, string $dataKey): array
{
    $stmt = $pdo->prepare("SELECT data_value FROM bb1_app_state WHERE data_key = ? LIMIT 1 FOR UPDATE");
    $stmt->execute([$dataKey]);
    $value = $stmt->fetchColumn();
    if ($value === false) return [];

    $records = json_decode((string) $value, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($records)) {
        throw new RuntimeException("Saved resident records are not a list.");
    }

    return $records;
}

function getResidentCodeFromRecord(array $record): string
{
    foreach (["code", "residentCode", "resident_code"] as $field) {
        if (is_string($record[$field] ?? null) && trim($record[$field]) !== "") {
            return strtoupper(trim($record[$field]));
        }
    }

    return "";
}

function findSharedResident(array $records, string $residentCode): ?array
{
    foreach ($records as $record) {
        if (is_array($record) && getResidentCodeFromRecord($record) === $residentCode) {
            return $record;
        }
    }

    return null;
}

function findApprovedRegistrationEmail(PDO $pdo, string $residentCode): string
{
    $registrations = loadAppStateRecordsForUpdate($pdo, "bb1-registration-requests");
    foreach ($registrations as $registration) {
        if (
            !is_array($registration)
            || strtolower(trim((string) ($registration["status"] ?? ""))) !== "approved"
            || strtoupper(trim((string) ($registration["assignedResidentCode"] ?? ""))) !== $residentCode
        ) {
            continue;
        }

        $registrationData = $registration["data"] ?? null;
        $email = is_array($registrationData) ? ($registrationData["emailAddress"] ?? "") : "";
        if (is_string($email) && trim($email) !== "") {
            return trim($email);
        }
    }

    return "";
}

function residentCodeExistsInRecords(array $records, string $residentCode): bool
{
    foreach ($records as $record) {
        if (is_array($record) && getResidentCodeFromRecord($record) === $residentCode) {
            return true;
        }
    }

    return false;
}

function updateResidentCodeInAppState(PDO $pdo, string $previousCode, string $newCode): void
{
    $stateFields = [
        "bb1-resident-records" => ["code", "residentCode", "resident_code"],
        "bb1-resident-requests" => ["residentCode", "resident_code"],
        "bb1-resident-payment-drafts" => ["residentCode", "resident_code"],
        "bb1-resident-request-drafts" => ["residentCode", "resident_code"],
        "bb1-registration-requests" => ["assignedResidentCode", "residentCode", "resident_code"],
        "bb1-resident-profile-update-requests" => ["residentCode", "resident_code"],
        "bb1-resident-history" => ["residentCode", "resident_code"],
        "bb1-archived-residents" => ["code", "residentCode", "resident_code"],
        "bb1-issued-documents" => ["residentCode", "resident_code"],
        "bb1-resident-code-recovery-requests" => ["matchedResidentCode", "residentCode"],
    ];
    $keys = array_keys($stateFields);
    $placeholders = implode(",", array_fill(0, count($keys), "?"));
    $select = $pdo->prepare("SELECT data_key, data_value FROM bb1_app_state WHERE data_key IN ($placeholders) FOR UPDATE");
    $select->execute($keys);
    $update = $pdo->prepare("UPDATE bb1_app_state SET data_value = ? WHERE data_key = ?");

    foreach ($select->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $records = json_decode((string) $row["data_value"], true, 512, JSON_THROW_ON_ERROR);
        if (!is_array($records)) {
            throw new RuntimeException("Saved resident records are not a list.");
        }
        $records = replaceResidentCodeFields(
            $records,
            $previousCode,
            $newCode,
            $stateFields[$row["data_key"]],
            $row["data_key"] === "bb1-resident-records" ? date(DATE_ATOM) : null
        );
        $update->execute([
            json_encode($records, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
            $row["data_key"],
        ]);
    }
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    header("Allow: POST, OPTIONS");
    respond(405, ["success" => false, "message" => "Method not allowed."]);
}

$admin = authenticateUser($pdo, ["admin", "official"]);
$input = json_decode(file_get_contents("php://input"), true);
$action = is_array($input) ? strtolower(trim((string) ($input["action"] ?? "send_code"))) : "";

if ($action === "decline_notice") {
    $requestId = $input["request_id"] ?? "";
    $recipient = $input["recipient_email"] ?? "";
    $residentName = $input["resident_name"] ?? "";
    if (
        !is_string($requestId)
        || !preg_match('/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/', $requestId)
        || !is_string($recipient)
        || !filter_var(trim($recipient), FILTER_VALIDATE_EMAIL)
        || !is_string($residentName)
        || trim($residentName) === ""
    ) {
        respond(422, ["success" => false, "message" => "A valid request reference, resident name, and email address are required."]);
    }

    $recipient = strtolower(trim($recipient));
    try {
        $requestState = $pdo->prepare("SELECT data_value FROM bb1_app_state WHERE data_key = ? LIMIT 1");
        $requestState->execute(["bb1-resident-code-recovery-requests"]);
        $storedRequests = $requestState->fetchColumn();
        $requests = is_string($storedRequests)
            ? json_decode($storedRequests, true, 512, JSON_THROW_ON_ERROR)
            : null;
        $recoveryRequest = null;
        foreach (is_array($requests) ? $requests : [] as $candidate) {
            if (is_array($candidate) && ($candidate["id"] ?? null) === $requestId) {
                $recoveryRequest = $candidate;
                break;
            }
        }
        if (!$recoveryRequest) {
            respond(404, ["success" => false, "message" => "The recovery request was not found."]);
        }
        if (!in_array($recoveryRequest["status"] ?? "", ["Pending", "Verified"], true)) {
            respond(409, ["success" => false, "message" => "Only pending recovery requests can receive a decline notice."]);
        }
        if (
            strtolower(trim((string) ($recoveryRequest["emailAddress"] ?? ""))) !== $recipient
            || trim((string) ($recoveryRequest["fullName"] ?? "")) !== trim($residentName)
        ) {
            respond(409, ["success" => false, "message" => "The email or resident name does not match the saved recovery request."]);
        }
    } catch (JsonException $error) {
        respond(500, ["success" => false, "message" => "The saved recovery request could not be read."]);
    } catch (Throwable $error) {
        error_log("Recovery decline request lookup failed.");
        respond(500, ["success" => false, "message" => "Unable to verify the recovery request. Please try again."]);
    }

    try {
        sendRecoveryDeclinedNotice($recipient, trim($residentName), $requestId);
        respond(200, [
            "success" => true,
            "message" => "The apology notice was emailed without a resident code.",
            "data" => [
                "delivery_status" => "Sent",
                "destination" => maskRecoveryDestination($recipient),
            ],
        ]);
    } catch (RecoveryDeliveryException $error) {
        respond($error->httpStatus, ["success" => false, "message" => $error->getMessage()]);
    } catch (Throwable $error) {
        error_log("Recovery decline notice error.");
        respond(500, ["success" => false, "message" => "Unable to send the decline notice. Please try again."]);
    }
}

if (!in_array($action, ["send_code", "rotate_code"], true)) {
    respond(422, ["success" => false, "message" => "Unsupported recovery email action."]);
}

$residentCode = is_array($input) ? strtoupper(trim($input["resident_code"] ?? "")) : "";
$deliveryMethod = is_array($input) ? strtolower(trim($input["delivery_method"] ?? "")) : "";

if (!preg_match('/^BB1-[A-Z0-9]{1,8}-\d{3}$/', $residentCode)) {
    respond(422, ["success" => false, "message" => "A valid existing resident code is required."]);
}
if ($deliveryMethod !== "email") {
    respond(422, ["success" => false, "message" => "Only email delivery is available."]);
}

try {
    $pdo->beginTransaction();

    $residentStmt = $pdo->prepare("
        SELECT
            r.id,
            r.user_id,
            r.first_name,
            r.last_name,
            r.resident_code,
            r.record_status,
            u.email,
            u.role,
            u.account_status
        FROM residents r
        LEFT JOIN users u ON u.id = r.user_id
        WHERE r.resident_code = ?
        LIMIT 1
        FOR UPDATE
    ");
    $residentStmt->execute([$residentCode]);
    $resident = $residentStmt->fetch(PDO::FETCH_ASSOC);
    $directoryRecords = loadAppStateRecordsForUpdate($pdo, "bb1-resident-records");
    $isDatabaseResident = is_array($resident);

    if ($isDatabaseResident) {
        if (
            strtolower(trim((string) ($resident["record_status"] ?? ""))) !== "active"
            || strtolower(trim((string) ($resident["role"] ?? ""))) !== "resident"
            || strtolower(trim((string) ($resident["account_status"] ?? ""))) !== "active"
        ) {
            $pdo->rollBack();
            respond(404, ["success" => false, "message" => "The verified resident account was not found or is inactive."]);
        }
    } else {
        $resident = findSharedResident($directoryRecords, $residentCode);
        if (
            !$resident
            || (isset($resident["recordStatus"]) && strtolower(trim((string) $resident["recordStatus"])) !== "active")
        ) {
            $pdo->rollBack();
            respond(404, ["success" => false, "message" => "The verified resident record was not found or is inactive."]);
        }
    }

    $previousCode = $isDatabaseResident
        ? strtoupper(trim((string) $resident["resident_code"]))
        : getResidentCodeFromRecord($resident);
    if (!preg_match('/^BB1-[A-Z0-9]{1,8}-\d{3}$/', $previousCode)) {
        $pdo->rollBack();
        respond(409, ["success" => false, "message" => "The resident account does not have a valid login code to replace."]);
    }
    $destination = trim((string) ($resident["email"] ?? $resident["emailAddress"] ?? $resident["email_address"] ?? ""));
    if ($destination === "" && !$isDatabaseResident) {
        $destination = findApprovedRegistrationEmail($pdo, $previousCode);
    }
    if ($destination === "") {
        $pdo->rollBack();
        respond(422, [
            "success" => false,
            "message" => "The resident does not have a saved email address. Update the resident record before sending a code."
        ]);
    }
    if ($deliveryMethod === "email" && !filter_var($destination, FILTER_VALIDATE_EMAIL)) {
        $pdo->rollBack();
        respond(422, ["success" => false, "message" => "The saved email address is invalid. Update the resident record before sending a code."]);
    }

    $firstName = trim((string) ($resident["first_name"] ?? $resident["firstName"] ?? ""));
    $lastName = trim((string) ($resident["last_name"] ?? $resident["lastName"] ?? ""));
    if ($firstName === "" || $lastName === "") {
        $nameParts = preg_split('/\s+/', trim((string) ($resident["name"] ?? "")), -1, PREG_SPLIT_NO_EMPTY);
        if (is_array($nameParts) && count($nameParts) >= 2) {
            $firstName = $firstName !== "" ? $firstName : $nameParts[0];
            $lastName = $lastName !== "" ? $lastName : $nameParts[count($nameParts) - 1];
        }
    }
    if ($firstName === "" || $lastName === "") {
        $pdo->rollBack();
        respond(409, ["success" => false, "message" => "The resident name is incomplete."]);
    }
    if (!preg_match('/^(BB1-[A-Z0-9]{1,8})-\d{3}$/', $previousCode, $codePrefixMatch)) {
        $pdo->rollBack();
        respond(409, ["success" => false, "message" => "The existing resident code cannot be rotated safely."]);
    }
    $codePrefix = $codePrefixMatch[1];

    $sequenceStmt = $pdo->query("
        SELECT next_number
        FROM resident_code_sequence
        WHERE id = 1
        FOR UPDATE
    ");
    $sequence = $sequenceStmt->fetch(PDO::FETCH_ASSOC);
    if (!$sequence) {
        throw new RuntimeException("Resident code sequence is not initialized.");
    }

    $number = (int) $sequence["next_number"];
    $codeLookup = $pdo->prepare("SELECT id FROM residents WHERE resident_code = ? LIMIT 1");
    $newCode = "";
    while ($number >= 1 && $number <= 999) {
        $candidate = sprintf("%s-%03d", $codePrefix, $number);
        $codeLookup->execute([$candidate]);
        if ($codeLookup->fetchColumn() === false && !residentCodeExistsInRecords($directoryRecords, $candidate)) {
            $newCode = $candidate;
            break;
        }
        $number++;
    }
    if ($newCode === "") {
        $pdo->rollBack();
        respond(409, ["success" => false, "message" => "No unused resident code is available in the current sequence."]);
    }

    $updateSequence = $pdo->prepare("UPDATE resident_code_sequence SET next_number = ? WHERE id = 1");
    $updateSequence->execute([$number + 1]);
    if ($isDatabaseResident) {
        $updateResident = $pdo->prepare("UPDATE residents SET resident_code = ? WHERE id = ?");
        $updateResident->execute([$newCode, $resident["id"]]);
    }
    updateResidentCodeInAppState($pdo, $previousCode, $newCode);

    if ($isDatabaseResident) {
        $historyStmt = $pdo->prepare("
            INSERT INTO resident_history (
                resident_id,
                user_id,
                transaction_type,
                description,
                reference_type,
                reference_id
            )
            VALUES (?, ?, ?, ?, ?, NULL)
        ");
        $historyStmt->execute([
            $resident["id"],
            $admin["id"],
            "resident_code_recovery",
            "Resident login code was replaced and emailed to the saved address during an admin-verified recovery request.",
            "resident_code_recovery_request",
        ]);
    }

    sendRecoveryCodeByEmail($destination, trim($firstName . " " . $lastName), $newCode);

    $pdo->commit();
    respond(200, [
        "success" => true,
        "message" => "A new resident login code was emailed to the saved address and the resident record was updated.",
        "data" => [
            "delivery_method" => $deliveryMethod,
            "delivery_status" => "Sent",
            "destination" => maskRecoveryDestination($destination),
            "resident_id" => $isDatabaseResident
                ? (int) $resident["id"]
                : (string) ($resident["id"] ?? $previousCode),
            "resident_source" => $isDatabaseResident ? "database" : "shared",
            "previous_resident_code" => $previousCode,
            "resident_code" => $newCode,
        ],
    ]);
} catch (RecoveryDeliveryException $error) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    respond($error->httpStatus, ["success" => false, "message" => $error->getMessage()]);
} catch (Throwable $error) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("Resident code recovery error: " . $error->getMessage());
    respond(500, ["success" => false, "message" => "Unable to send the resident login code. Please try again."]);
}
