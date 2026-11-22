<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

$user = authenticateUser($pdo, ["admin", "official"]);

function restoreRespond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER["REQUEST_METHOD"] ?? "") !== "POST") {
    header("Allow: POST, OPTIONS");
    restoreRespond(405, ["success" => false, "message" => "Method not allowed."]);
}

$allowedKeys = [
    "bb1-resident-records",
    "bb1-resident-requests",
    "bb1-registration-requests",
    "bb1-resident-history",
    "bb1-issued-documents",
    "bb1-resident-request-drafts",
    "bb1-resident-payment-drafts",
    "bb1-archived-residents",
];

$input = json_decode(file_get_contents("php://input"), false, 512, JSON_THROW_ON_ERROR);
if (!($input instanceof stdClass)
    || !property_exists($input, "restoreKeys")
    || !is_array($input->restoreKeys)
    || count($input->restoreKeys) > count($allowedKeys)) {
    restoreRespond(400, ["success" => false, "message" => "A valid restore key list is required."]);
}

$keys = array_values(array_unique($input->restoreKeys));
foreach ($keys as $key) {
    if (!is_string($key) || !in_array($key, $allowedKeys, true)) {
        restoreRespond(400, ["success" => false, "message" => "An unsupported restore key was requested."]);
    }
}

function restoreRecordTimestamp($record): int
{
    if (!is_object($record)) return 0;
    foreach (["updatedAt", "reviewedAt", "submittedAt", "requestedAt", "createdAt"] as $field) {
        if (isset($record->{$field}) && is_string($record->{$field})) {
            $timestamp = strtotime($record->{$field});
            if ($timestamp !== false) return $timestamp;
        }
    }
    return 0;
}

function restoreRecordIdentity($record): string
{
    if (!is_object($record)) return "";
    foreach (["id", "code", "residentCode", "resident_code", "submissionId"] as $field) {
        if (isset($record->{$field}) && (is_string($record->{$field}) || is_int($record->{$field}))) {
            $value = trim((string) $record->{$field});
            if ($value !== "") return strtolower($value);
        }
    }
    return "";
}

try {
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS bb1_app_state_snapshots (
            snapshot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            data_key VARCHAR(100) NOT NULL,
            data_value LONGTEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_snapshot_key_created (data_key, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $pdo->beginTransaction();
    $restored = [];
    $snapshotStmt = $pdo->prepare("
        SELECT data_value
        FROM bb1_app_state_snapshots
        WHERE data_key = ?
        ORDER BY snapshot_id DESC
        LIMIT 1
    ");
    $currentStmt = $pdo->prepare("
        SELECT data_value
        FROM bb1_app_state
        WHERE data_key = ?
        LIMIT 1
        FOR UPDATE
    ");
    $upsert = $pdo->prepare("
        INSERT INTO bb1_app_state (data_key, data_value)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE data_value = VALUES(data_value)
    ");

    foreach ($keys as $key) {
        $snapshotStmt->execute([$key]);
        $snapshotJson = $snapshotStmt->fetchColumn();
        if ($snapshotJson === false) continue;
        $snapshotRecords = json_decode((string) $snapshotJson, false, 512, JSON_THROW_ON_ERROR);
        if (!is_array($snapshotRecords)) continue;

        $currentStmt->execute([$key]);
        $currentJson = $currentStmt->fetchColumn();
        $currentRecords = $currentJson === false
            ? []
            : json_decode((string) $currentJson, false, 512, JSON_THROW_ON_ERROR);
        if (!is_array($currentRecords)) $currentRecords = [];

        $merged = [];
        $byIdentity = [];
        $unkeyed = [];
        foreach (array_merge($snapshotRecords, $currentRecords) as $record) {
            $identity = restoreRecordIdentity($record);
            if ($identity === "") {
                $encoded = json_encode($record, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                if (!in_array($encoded, $unkeyed, true)) $unkeyed[] = $encoded;
                continue;
            }
            $existing = $byIdentity[$identity] ?? null;
            if ($existing === null
                || restoreRecordTimestamp($record) >= restoreRecordTimestamp($existing)) {
                $byIdentity[$identity] = $record;
            }
        }
        $merged = array_values($byIdentity);
        foreach ($unkeyed as $encodedRecord) {
            $merged[] = json_decode($encodedRecord, false, 512, JSON_THROW_ON_ERROR);
        }
        $upsert->execute([
            $key,
            json_encode($merged, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
        ]);
        $restored[$key] = count($merged);
    }

    $pdo->commit();
    restoreRespond(200, [
        "success" => true,
        "restored" => $restored,
    ]);
} catch (Throwable $error) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("App-state restore error: " . $error->getMessage());
    restoreRespond(500, ["success" => false, "message" => "The server records could not be restored safely."]);
}
