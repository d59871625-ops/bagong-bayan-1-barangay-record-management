<?php

header("Content-Type: application/json; charset=UTF-8");
if (!in_array($_SERVER["REMOTE_ADDR"] ?? "", ["127.0.0.1", "::1"], true)) {
    http_response_code(403);
    echo json_encode([
        "success" => false,
        "message" => "The shared app-state API is restricted to local development."
    ]);
    exit;
}

require_once __DIR__ . "/db.php";

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function residentNameKey(string $name): string
{
    $name = function_exists("mb_strtolower")
        ? mb_strtolower($name, "UTF-8")
        : strtolower($name);
    return preg_replace('/[^\p{L}\p{N}]+/u', '', $name) ?? "";
}

function residentRecordName(stdClass $record): string
{
    foreach (["name", "fullName", "full_name"] as $field) {
        if (isset($record->{$field}) && is_string($record->{$field}) && trim($record->{$field}) !== "") {
            return trim($record->{$field});
        }
    }

    $parts = [];
    foreach (["firstName", "middleName", "lastName", "suffix"] as $field) {
        if (isset($record->{$field}) && is_string($record->{$field}) && trim($record->{$field}) !== "") {
            $parts[] = trim($record->{$field});
        }
    }
    return implode(" ", $parts);
}

function residentRecordIdentity(stdClass $record): ?string
{
    foreach (["id", "code", "residentCode", "resident_code"] as $field) {
        if (isset($record->{$field}) && (is_string($record->{$field}) || is_int($record->{$field}))) {
            return strtolower(trim((string) $record->{$field}));
        }
    }
    return null;
}

$allowedKeys = [
    "bb1-community-updates",
    "bb1-about-contact-information",
    "bb1-resident-requests",
    "bb1-deleted-request-ids",
    "bb1-resident-payment-drafts",
    "bb1-resident-request-drafts",
    "bb1-gcash-recipients",
    "bb1-resident-records",
    "bb1-registration-requests",
    "bb1-resident-code-recovery-requests",
    "bb1-resident-profile-update-requests",
    "bb1-document-fees",
    "bb1-document-fees-defaults-version",
    "bb1-admin-preferences",
    "bb1-resident-history",
    "bb1-archived-residents",
    "bb1-issued-documents",
    "bb1-certificate-templates",
    "bb1-official-availability",
    "bb1-enabled-certificate-types",
    "bb1-official-profiles",
    "bb1-official-photos"
];

try {
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS bb1_app_state (
            data_key VARCHAR(100) NOT NULL PRIMARY KEY,
            data_value LONGTEXT NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    if ($_SERVER["REQUEST_METHOD"] === "GET") {
        $placeholders = implode(",", array_fill(0, count($allowedKeys), "?"));
        $statement = $pdo->prepare(
            "SELECT data_key, data_value FROM bb1_app_state WHERE data_key IN ($placeholders)"
        );
        $statement->execute($allowedKeys);

        $data = [];
        foreach ($statement->fetchAll() as $row) {
            $data[$row["data_key"]] = json_decode($row["data_value"], false, 512, JSON_THROW_ON_ERROR);
        }

        respond(200, ["success" => true, "data" => (object) $data]);
    }

    if ($_SERVER["REQUEST_METHOD"] !== "POST") {
        header("Allow: GET, POST, OPTIONS");
        respond(405, ["success" => false, "message" => "Method not allowed."]);
    }

    $input = json_decode(file_get_contents("php://input"), false, 512, JSON_THROW_ON_ERROR);
    if (!($input instanceof stdClass)) {
        respond(400, ["success" => false, "message" => "A records object or key and value are required."]);
    }

    $records = property_exists($input, "records")
        ? $input->records
        : (isset($input->key) && property_exists($input, "value")
            ? (object) [$input->key => $input->value]
            : null);
    if (!($records instanceof stdClass) || !get_object_vars($records)) {
        respond(400, ["success" => false, "message" => "A non-empty records object is required."]);
    }

    $encodedRecords = [];
    foreach ($records as $key => $recordValue) {
        if (!is_string($key) || !in_array($key, $allowedKeys, true)) {
            respond(400, ["success" => false, "message" => "This record is not enabled for database storage."]);
        }
        if ($key === "bb1-resident-records") {
            if (!is_array($recordValue) || ($recordValue && array_keys($recordValue) !== range(0, count($recordValue) - 1))) {
                respond(400, ["success" => false, "message" => "Resident records must be a list."]);
            }
            $names = [];
            foreach ($recordValue as $resident) {
                if (!($resident instanceof stdClass)) {
                    respond(400, ["success" => false, "message" => "Each resident record must be an object."]);
                }
                $nameKey = residentNameKey(residentRecordName($resident));
                if (!$nameKey) continue;
                if (isset($names[$nameKey])) {
                    respond(409, ["success" => false, "message" => "A resident with this name already exists. The duplicate record was not saved."]);
                }
                $names[$nameKey] = residentRecordIdentity($resident);
            }
        }
        $encodedRecords[$key] = json_encode(
            $recordValue,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
        );
    }

    $statement = $pdo->prepare("
        INSERT INTO bb1_app_state (data_key, data_value)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE data_value = VALUES(data_value)
    ");
    $pdo->beginTransaction();
    try {
        foreach ($encodedRecords as $key => $value) {
            if ($key === "bb1-resident-records") {
                $existingStatement = $pdo->prepare("
                    SELECT data_value
                    FROM bb1_app_state
                    WHERE data_key = ?
                    LIMIT 1
                    FOR UPDATE
                ");
                $existingStatement->execute([$key]);
                $existingJson = $existingStatement->fetchColumn();
                if ($existingJson !== false) {
                    $existingResidents = json_decode($existingJson, false, 512, JSON_THROW_ON_ERROR);
                    if (!is_array($existingResidents)) {
                        throw new RuntimeException("Saved resident records are not a list.");
                    }
                    $existingIdentities = [];
                    foreach ($existingResidents as $resident) {
                        if ($resident instanceof stdClass) {
                            $identity = residentRecordIdentity($resident);
                            if ($identity !== null) $existingIdentities[$identity] = true;
                        }
                    }
                    foreach ($records->{$key} as $resident) {
                        if (!($resident instanceof stdClass) || residentRecordIdentity($resident) === null) continue;
                        $identity = residentRecordIdentity($resident);
                        if (isset($existingIdentities[$identity])) continue;
                        $nameKey = residentNameKey(residentRecordName($resident));
                        if (!$nameKey) continue;
                        foreach ($existingResidents as $existingResident) {
                            if (!($existingResident instanceof stdClass)) continue;
                            if (residentRecordName($existingResident) === "") continue;
                            if (residentNameKey(residentRecordName($existingResident)) === $nameKey) {
                                if ($pdo->inTransaction()) $pdo->rollBack();
                                respond(409, ["success" => false, "message" => "A resident with this name already exists. The duplicate record was not saved."]);
                            }
                        }
                    }
                }
            }
            $statement->execute([$key, $value]);
        }
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }

    respond(200, ["success" => true, "saved" => array_keys($encodedRecords)]);
} catch (JsonException $e) {
    respond(400, ["success" => false, "message" => "The request or stored record contains invalid JSON."]);
} catch (Throwable $e) {
    error_log("Application data API error: " . $e->getMessage());
    respond(500, ["success" => false, "message" => "Unable to access the application database."]);
}
