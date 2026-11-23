<?php

use PHPMailer\PHPMailer\PHPMailer;

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");
ob_start();
$recoveryBootstrapStage = "composer autoloader";
register_shutdown_function(static function () use (&$recoveryBootstrapStage): void {
    $error = error_get_last();
    if (!$error || !in_array($error["type"], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true)) {
        return;
    }

    error_log(sprintf(
        "Resident code recovery bootstrap fatal: stage=%s type=%d file=%s line=%d message=%s",
        $recoveryBootstrapStage,
        $error["type"],
        basename((string) ($error["file"] ?? "unknown")),
        (int) ($error["line"] ?? 0),
        preg_replace('/[\r\n]+/', ' ', (string) ($error["message"] ?? "unknown"))
    ));
    if (!headers_sent()) {
        http_response_code(500);
        header("Content-Type: application/json; charset=UTF-8");
    }
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    echo json_encode([
        "success" => false,
        "message" => "The resident recovery service failed during {$recoveryBootstrapStage}. Check the backend PHP error log.",
        "stage" => $recoveryBootstrapStage,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
});

try {
    $recoveryAutoloadPath = __DIR__ . "/vendor/autoload.php";
    if (!is_file($recoveryAutoloadPath)) {
        throw new RuntimeException("Composer autoload.php is missing from the deployed backend.");
    }
    require_once $recoveryAutoloadPath;
    $recoveryBootstrapStage = "database connection";
    require_once __DIR__ . "/db.php";
    $recoveryBootstrapStage = "admin authentication and request storage";
    require_once __DIR__ . "/auth.php";
    require_once __DIR__ . "/resident-request-storage.php";
} catch (Throwable $error) {
    error_log(sprintf(
        "Resident code recovery bootstrap error: stage=%s type=%s message=%s",
        $recoveryBootstrapStage,
        get_class($error),
        preg_replace('/[\r\n]+/', ' ', $error->getMessage())
    ));
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    http_response_code(500);
    header("Content-Type: application/json; charset=UTF-8");
    echo json_encode([
        "success" => false,
        "message" => "The resident recovery service could not start. Check the backend PHP error log.",
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

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
    $username = "airi55877@gmail.com";
    $appPassword = preg_replace('/\s+/', '', (string) backendEnv("BRGY_GMAIL_APP_PASSWORD"));
    if ($appPassword === "") {
        throw new RecoveryDeliveryException("Gmail app password is not configured on the backend.", 503);
    }

    $senderName = trim((string) backendEnv("BRGY_GMAIL_FROM_NAME")) ?: "Barangay Bagong Bayan I";
    $transportAttempts = [
        [587, PHPMailer::ENCRYPTION_STARTTLS],
        [465, PHPMailer::ENCRYPTION_SMTPS],
    ];
    $lastError = null;

    foreach ($transportAttempts as [$port, $encryption]) {
        try {
            $mail = new PHPMailer(true);
            $mail->isSMTP();
            $mail->Host = "smtp.gmail.com";
            $mail->SMTPAuth = true;
            $mail->Username = $username;
            $mail->Password = $appPassword;
            $mail->SMTPSecure = $encryption;
            $mail->Port = $port;
            $mail->Timeout = 20;
            $mail->SMTPKeepAlive = false;
            $mail->CharSet = "UTF-8";
            $mail->setFrom($username, $senderName);
            $mail->addAddress($recipient, $recipientName);
            $mail->Subject = $subject;
            $mail->Body = $body;
            $mail->AltBody = $body;
            $mail->send();
            return;
        } catch (Throwable $error) {
            $lastError = $error;
            error_log("Resident recovery email delivery failed on Gmail SMTP port {$port}: " . $error->getMessage());
        }
    }

    throw new RecoveryDeliveryException(
        $lastError instanceof Throwable
            ? "Gmail could not deliver the recovery email. Check the configured Gmail address and app password."
            : "Gmail could not deliver the recovery email.",
        502
    );
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

function ensureRecoveryResidentCodeSequence(PDO $pdo): void
{
    $pdo->exec("CREATE TABLE IF NOT EXISTS resident_code_sequence (
        id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        next_number INT UNSIGNED NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("INSERT IGNORE INTO resident_code_sequence (id, next_number) VALUES (1, 1)");
}

function createRecoveryResidentCode(PDO $pdo, array $directoryRecords, array $archivedRecords): string
{
    $sequenceStmt = $pdo->query("SELECT next_number FROM resident_code_sequence WHERE id = 1 FOR UPDATE");
    $number = max(1, (int) $sequenceStmt->fetchColumn());
    $databaseCodes = $pdo->query("SELECT resident_code FROM residents FOR UPDATE")->fetchAll(PDO::FETCH_COLUMN);
    $usedCodes = [];
    foreach ($databaseCodes as $databaseCode) {
        $normalizedCode = strtoupper(trim((string) $databaseCode));
        if ($normalizedCode !== "") $usedCodes[$normalizedCode] = true;
    }
    foreach (array_merge($directoryRecords, $archivedRecords) as $record) {
        if (is_array($record)) {
            $existingCode = getResidentCodeFromRecord($record);
            if ($existingCode !== "") $usedCodes[$existingCode] = true;
        }
    }

    $number = (($number - 1) % 999) + 1;
    for ($attempt = 0; $attempt < 5000; $attempt++) {
        $letterCount = random_int(2, 3);
        $letters = "";
        for ($index = 0; $index < $letterCount; $index++) {
            $letters .= chr(random_int(65, 90));
        }
        $candidate = sprintf("BB1-%s-%03d", $letters, $number);
        if (!isset($usedCodes[$candidate])) {
            $nextNumber = $number === 999 ? 1 : $number + 1;
            $updateSequence = $pdo->prepare("UPDATE resident_code_sequence SET next_number = ? WHERE id = 1");
            $updateSequence->execute([$nextNumber]);
            return $candidate;
        }
        $number = $number === 999 ? 1 : $number + 1;
    }
    throw new RecoveryDeliveryException("A unique resident code could not be generated. Try approving this request again.", 409);
}

function updateResidentCodeInAppState(PDO $pdo, string $previousCode, string $newCode, bool $requireResidentDirectory = false): void
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
    $residentDirectoryFound = false;

    foreach ($select->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $dataKey = (string) $row["data_key"];
        $isResidentDirectory = $dataKey === "bb1-resident-records";
        $residentDirectoryFound = $residentDirectoryFound || $isResidentDirectory;
        try {
            $records = json_decode((string) $row["data_value"], true, 512, JSON_THROW_ON_ERROR);
            if (!is_array($records)) {
                throw new RuntimeException("Saved records are not a list.");
            }
            if ($isResidentDirectory && !residentCodeExistsInRecords($records, $previousCode)) {
                if ($requireResidentDirectory) {
                    throw new RuntimeException("The current login code was not found in the resident directory.");
                }
                continue;
            }
            $records = replaceResidentCodeFields(
                $records,
                $previousCode,
                $newCode,
                $stateFields[$dataKey],
                $isResidentDirectory ? date(DATE_ATOM) : null
            );
            if ($isResidentDirectory && $requireResidentDirectory && !residentCodeExistsInRecords($records, $newCode)) {
                throw new RuntimeException("The new login code was not saved in the resident directory.");
            }
            $update->execute([
                json_encode($records, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
                $dataKey,
            ]);
        } catch (Throwable $error) {
            error_log("Resident recovery app-state update failed for {$dataKey}: " . $error->getMessage());
            if ($isResidentDirectory) {
                throw new RuntimeException("The resident directory could not be updated with the new login code.", 0, $error);
            }
        }
    }

    if ($requireResidentDirectory && !$residentDirectoryFound) {
        throw new RuntimeException("The resident directory record is missing.");
    }
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    header("Allow: POST, OPTIONS");
    respond(405, ["success" => false, "message" => "Method not allowed."]);
}

$recoveryBootstrapStage = "request authorization";
$admin = authenticateUser($pdo, ["admin", "official"]);
$recoveryBootstrapStage = "request parsing";
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
        $recoveryBootstrapStage = "decline notice lookup";
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
        $recoveryBootstrapStage = "decline notice email delivery";
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
    $recoveryBootstrapStage = "resident lookup and code preparation";
    bb1EnsureSyncRevisionTable($pdo);
    ensureRecoveryResidentCodeSequence($pdo);
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
    $archivedRecords = loadAppStateRecordsForUpdate($pdo, "bb1-archived-residents");
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
    if ($destination === "") {
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
    if (!preg_match('/^BB1-[A-Z0-9]{1,8}-\d{3}$/', $previousCode)) {
        $pdo->rollBack();
        respond(409, ["success" => false, "message" => "The existing resident code cannot be rotated safely."]);
    }
    $newCode = createRecoveryResidentCode($pdo, $directoryRecords, $archivedRecords);

    // Deliver first so a failed email leaves the previous working code and records unchanged.
    $recoveryBootstrapStage = "Gmail recovery email delivery";
    sendRecoveryCodeByEmail($destination, trim($firstName . " " . $lastName), $newCode);

    $recoveryBootstrapStage = "database resident code write";
    if ($isDatabaseResident) {
        $updateResident = $pdo->prepare("UPDATE residents SET resident_code = ? WHERE id = ?");
        $updateResident->execute([$newCode, $resident["id"]]);
        if ($updateResident->rowCount() !== 1) {
            throw new RuntimeException("The database did not confirm the new resident login code.");
        }
    }
    $recoveryBootstrapStage = "resident directory code write";
    updateResidentCodeInAppState($pdo, $previousCode, $newCode, !$isDatabaseResident);

    if ($isDatabaseResident) {
        try {
            $recoveryBootstrapStage = "optional recovery history write";
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
        } catch (Throwable $historyError) {
            error_log("Resident recovery history write failed: " . $historyError->getMessage());
        }
    }

    try {
        $recoveryBootstrapStage = "sync revision update";
        bb1BumpSyncRevision($pdo);
    } catch (Throwable $revisionError) {
        error_log("Resident recovery sync revision update failed: " . $revisionError->getMessage());
    }
    $recoveryBootstrapStage = "resident code commit";
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
    error_log("Resident code recovery error at {$recoveryBootstrapStage}: " . get_class($error) . " " . $error->getMessage());
    respond(500, [
        "success" => false,
        "stage" => $recoveryBootstrapStage,
        "message" => "The email was sent, but the new code could not be saved during {$recoveryBootstrapStage}. The previous code remains active; retry the recovery approval.",
    ]);
}
