<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
header("Pragma: no-cache");
header("Expires: 0");

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/resident-request-storage.php";

function recoveryRequestRespond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER["REQUEST_METHOD"] ?? "") !== "POST") {
    header("Allow: POST, OPTIONS");
    recoveryRequestRespond(405, ["success" => false, "message" => "Method not allowed."]);
}

$body = file_get_contents("php://input");
if ($body === false || strlen($body) > 65536) {
    recoveryRequestRespond(413, ["success" => false, "message" => "The recovery request is too large."]);
}

try {
    $input = json_decode($body, false, 32, JSON_THROW_ON_ERROR);
} catch (JsonException $error) {
    recoveryRequestRespond(400, ["success" => false, "message" => "Invalid recovery request data."]);
}

if (!($input instanceof stdClass)
    || array_diff(array_keys(get_object_vars($input)), [
        "requestId", "fullName", "birthDate", "emailAddress", "address", "reason",
    ])
    || !is_string($input->fullName ?? null)
    || !is_string($input->birthDate ?? null)
    || !is_string($input->emailAddress ?? null)
    || !is_string($input->address ?? null)
    || !is_string($input->reason ?? null)
    || (isset($input->requestId) && !is_string($input->requestId))) {
    recoveryRequestRespond(400, ["success" => false, "message" => "Invalid recovery request data."]);
}

$fullName = trim((string) ($input->fullName ?? ""));
$birthDate = trim((string) ($input->birthDate ?? ""));
$emailAddress = trim((string) ($input->emailAddress ?? ""));
$address = trim((string) ($input->address ?? ""));
$reason = trim((string) ($input->reason ?? ""));
$requestId = trim((string) ($input->requestId ?? ""));
if ($fullName === "" || strlen($fullName) > 200
    || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $birthDate)
    || !checkdate((int) substr($birthDate, 5, 2), (int) substr($birthDate, 8, 2), (int) substr($birthDate, 0, 4))
    || strlen($emailAddress) > 254 || !filter_var($emailAddress, FILTER_VALIDATE_EMAIL)
    || $address === "" || strlen($address) > 500
    || $reason === "" || strlen($reason) > 2000
    || ($requestId !== "" && !preg_match('/^(?:REC-[A-Z0-9-]{10,80}|RC-\d{4}-\d{6,20})$/', $requestId))) {
    recoveryRequestRespond(422, ["success" => false, "message" => "Complete the recovery request with valid details."]);
}

$clientAddress = (string) ($_SERVER["REMOTE_ADDR"] ?? "unknown");
$rateLimitKey = hash("sha256", $clientAddress);
$requestStateKey = "bb1-resident-code-recovery-requests";

try {
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS bb1_app_state (
            data_key VARCHAR(100) NOT NULL PRIMARY KEY,
            data_value LONGTEXT NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS bb1_public_recovery_rate_limits (
            ip_hash CHAR(64) NOT NULL PRIMARY KEY,
            window_started_at DATETIME NOT NULL,
            request_count INT UNSIGNED NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    bb1EnsureSyncRevisionTable($pdo);
    $pdo->beginTransaction();
    $pdo->exec("DELETE FROM bb1_public_recovery_rate_limits WHERE window_started_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)");
    $limit = $pdo->prepare("
        INSERT INTO bb1_public_recovery_rate_limits (ip_hash, window_started_at, request_count)
        VALUES (?, UTC_TIMESTAMP(), 1)
        ON DUPLICATE KEY UPDATE
            request_count = IF(window_started_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR), 1, request_count + 1),
            window_started_at = IF(window_started_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR), UTC_TIMESTAMP(), window_started_at)
    ");
    $limit->execute([$rateLimitKey]);
    $count = $pdo->prepare("SELECT request_count FROM bb1_public_recovery_rate_limits WHERE ip_hash = ? FOR UPDATE");
    $count->execute([$rateLimitKey]);
    if ((int) $count->fetchColumn() > 10) {
        $pdo->rollBack();
        recoveryRequestRespond(429, ["success" => false, "message" => "Too many recovery requests were submitted. Try again later."]);
    }

    $ensure = $pdo->prepare("
        INSERT IGNORE INTO bb1_app_state (data_key, data_value)
        VALUES (?, '[]')
    ");
    $ensure->execute([$requestStateKey]);
    $state = $pdo->prepare("SELECT data_value FROM bb1_app_state WHERE data_key = ? LIMIT 1 FOR UPDATE");
    $state->execute([$requestStateKey]);
    $savedJson = $state->fetchColumn();
    $requests = json_decode((string) $savedJson, true, 512, JSON_THROW_ON_ERROR);
    if (!is_array($requests)) {
        throw new RuntimeException("Saved recovery requests are not a list.");
    }

    $request = null;
    if ($requestId !== "") {
        foreach ($requests as $index => $candidate) {
            if (!is_array($candidate) || ($candidate["id"] ?? "") !== $requestId) continue;
            $sameIdentity = strtolower(trim((string) ($candidate["fullName"] ?? ""))) === strtolower($fullName)
                && ($candidate["birthDate"] ?? "") === $birthDate
                && strtolower(trim((string) ($candidate["emailAddress"] ?? ""))) === strtolower($emailAddress);
            if (!$sameIdentity || ($candidate["status"] ?? "") !== "Pending") {
                $pdo->rollBack();
                recoveryRequestRespond(404, ["success" => false, "message" => "This pending recovery request could not be found."]);
            }
            $request = [
                "id" => $requestId,
                "fullName" => $fullName,
                "birthDate" => $birthDate,
                "emailAddress" => $emailAddress,
                "mobileNumber" => "",
                "address" => $address,
                "reason" => $reason,
                "status" => "Pending",
                "submittedAt" => $candidate["submittedAt"] ?? gmdate("c"),
                "updatedAt" => gmdate("c"),
            ];
            $requests[$index] = $request;
            break;
        }
        if ($request === null) {
            $pdo->rollBack();
            recoveryRequestRespond(404, ["success" => false, "message" => "This pending recovery request could not be found."]);
        }
    } else {
        foreach ($requests as $index => $candidate) {
            if (is_array($candidate)
                && ($candidate["status"] ?? "") === "Pending"
                && strtolower(trim((string) ($candidate["fullName"] ?? ""))) === strtolower($fullName)
                && ($candidate["birthDate"] ?? "") === $birthDate
                && strtolower(trim((string) ($candidate["emailAddress"] ?? ""))) === strtolower($emailAddress)) {
                $request = [
                    "id" => $candidate["id"],
                    "fullName" => $fullName,
                    "birthDate" => $birthDate,
                    "emailAddress" => $emailAddress,
                    "mobileNumber" => "",
                    "address" => $address,
                    "reason" => $reason,
                    "status" => "Pending",
                    "submittedAt" => $candidate["submittedAt"] ?? gmdate("c"),
                    "updatedAt" => gmdate("c"),
                ];
                $requests[$index] = $request;
                break;
            }
        }
        if ($request === null) {
            $request = [
                "id" => "REC-" . gmdate("Ymd") . "-" . strtoupper(bin2hex(random_bytes(12))),
                "fullName" => $fullName,
                "birthDate" => $birthDate,
                "emailAddress" => $emailAddress,
                "mobileNumber" => "",
                "address" => $address,
                "reason" => $reason,
                "status" => "Pending",
                "submittedAt" => gmdate("c"),
            ];
            array_unshift($requests, $request);
        }
    }

    $update = $pdo->prepare("UPDATE bb1_app_state SET data_value = ? WHERE data_key = ?");
    $update->execute([
        json_encode(array_values($requests), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
        $requestStateKey,
    ]);
    bb1BumpSyncRevision($pdo);
    $pdo->commit();
    recoveryRequestRespond(200, ["success" => true, "data" => ["request" => $request]]);
} catch (Throwable $error) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("Public resident code recovery request error: " . $error->getMessage());
    recoveryRequestRespond(500, ["success" => false, "message" => "Unable to save the recovery request to the barangay database."]);
}
