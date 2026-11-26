<?php

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";
require_once __DIR__ . "/registration-application-storage.php";

header("Cache-Control: no-store");

function respond(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data);
    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    header("Allow: POST, OPTIONS");
    respond(405, ["success" => false, "message" => "Method not allowed."]);
}

$admin = authenticateUser($pdo, ["admin", "official"]);
$input = json_decode(file_get_contents("php://input"), true);
$residentCode = is_array($input) ? strtoupper(trim($input["resident_code"] ?? "")) : "";
$action = is_array($input) ? trim($input["action"] ?? "") : "";

if (!preg_match('/^BB1-[A-Z0-9]{1,8}-\d{3}$/', $residentCode)) {
    respond(422, ["success" => false, "message" => "A valid resident code is required."]);
}
if (!in_array($action, ["update_profile", "set_status", "delete_permanently"], true)) {
    respond(422, ["success" => false, "message" => "A supported resident account action is required."]);
}

try {
    if ($action === "delete_permanently") {
        $pdo->exec("CREATE TABLE IF NOT EXISTS bb1_app_state (
            data_key VARCHAR(100) NOT NULL PRIMARY KEY,
            data_value LONGTEXT NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
        $pdo->exec("CREATE TABLE IF NOT EXISTS bb1_app_state_snapshots (
            snapshot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            data_key VARCHAR(100) NOT NULL,
            data_value LONGTEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_snapshot_key_created (data_key, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    }
    $pdo->beginTransaction();
    $residentStmt = $pdo->prepare("
        SELECT r.id, r.user_id, r.first_name, r.middle_name, r.last_name, r.suffix, u.email
        FROM residents r
        INNER JOIN users u ON u.id = r.user_id
        WHERE r.resident_code = ?
          AND u.role = 'resident'
        LIMIT 1
        FOR UPDATE
    ");
    $residentStmt->execute([$residentCode]);
    $resident = $residentStmt->fetch(PDO::FETCH_ASSOC);
    if ($action === "delete_permanently") {
        // Remove access and the active directory entry, but keep request,
        // payment, issued-document, and resident-history records intact.
        $stateSelect = $pdo->prepare("SELECT data_key, data_value FROM bb1_app_state WHERE data_key IN (?, ?) FOR UPDATE");
        $stateSelect->execute(["bb1-resident-records", "bb1-registration-requests"]);
        $stateUpdate = $pdo->prepare("UPDATE bb1_app_state SET data_value = ? WHERE data_key = ?");
        $snapshot = $pdo->prepare("INSERT INTO bb1_app_state_snapshots (data_key, data_value) VALUES (?, ?)");
        foreach ($stateSelect->fetchAll(PDO::FETCH_ASSOC) as $stateRow) {
            $records = json_decode((string) $stateRow["data_value"], false, 512, JSON_THROW_ON_ERROR);
            if (!is_array($records)) {
                throw new RuntimeException("Saved resident data is invalid and could not be removed safely.");
            }
            $snapshot->execute([$stateRow["data_key"], $stateRow["data_value"]]);
            if ($stateRow["data_key"] === "bb1-resident-records") {
                $residentId = $resident ? (string) $resident["id"] : "";
                $records = array_values(array_filter($records, static function ($record) use ($residentCode, $residentId) {
                    if (!($record instanceof stdClass)) return true;
                    $code = strtoupper(trim((string) ($record->code ?? $record->residentCode ?? $record->resident_code ?? "")));
                    $id = trim((string) ($record->id ?? ""));
                    return $code !== $residentCode && ($residentId === "" || $id !== $residentId);
                }));
            } else {
                $residentId = $resident ? (string) $resident["id"] : "";
                $records = array_map(static function ($record) use ($residentCode, $residentId) {
                    if (!($record instanceof stdClass)) return $record;
                    $code = strtoupper(trim((string) ($record->assignedResidentCode ?? $record->residentCode ?? $record->resident_code ?? "")));
                    $recordResidentId = trim((string) ($record->residentId ?? $record->resident_id ?? ""));
                    if (($code === $residentCode || ($residentId !== "" && $recordResidentId === $residentId))
                        && ($record->status ?? "") === "Approved") {
                        $record->status = "Deleted";
                        $record->deletedAt = gmdate("c");
                    }
                    return $record;
                }, $records);
            }
            $stateUpdate->execute([
                json_encode($records, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
                $stateRow["data_key"],
            ]);
        }

        if ($resident) {
            $pdo->prepare("UPDATE residents SET record_status = 'inactive' WHERE id = ?")->execute([$resident["id"]]);
            $pdo->prepare("UPDATE users SET account_status = 'inactive' WHERE id = ? AND role = 'resident'")->execute([$resident["user_id"]]);
            $pdo->prepare("UPDATE api_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL")->execute([$resident["user_id"]]);
        }
        $pdo->commit();
        respond(200, ["success" => true, "message" => "Resident access was permanently removed. Payment history, issued documents, and request records were kept."]);
    }

    if (!$resident) {
        $pdo->rollBack();
        respond(404, ["success" => false, "message" => "The resident account was not found."]);
    }
    if ($action === "set_status") {
        $status = trim($input["status"] ?? "");
        if (!in_array($status, ["active", "inactive"], true)) {
            $pdo->rollBack();
            respond(422, ["success" => false, "message" => "Choose active or inactive account status."]);
        }
        $updateResident = $pdo->prepare("UPDATE residents SET record_status = ? WHERE id = ?");
        $updateResident->execute([$status, $resident["id"]]);
        $updateUser = $pdo->prepare("UPDATE users SET account_status = ? WHERE id = ?");
        $updateUser->execute([$status, $resident["user_id"]]);
        if ($status === "inactive") {
            $revokeTokens = $pdo->prepare("
                UPDATE api_tokens
                SET revoked_at = NOW()
                WHERE user_id = ?
                  AND revoked_at IS NULL
            ");
            $revokeTokens->execute([$resident["user_id"]]);
        }
    } else {
        $changes = is_array($input["changes"] ?? null) ? $input["changes"] : [];
        $allowed = ["first_name", "middle_name", "last_name", "suffix", "date_of_birth", "contact_number", "email", "address"];
        $unknownFields = array_diff(array_keys($changes), $allowed);
        if ($unknownFields) {
            $pdo->rollBack();
            respond(422, ["success" => false, "message" => "The profile update contains unsupported fields."]);
        }

        $residentChanges = [];
        $userChanges = [];
        $fieldLimits = [
            "first_name" => 100,
            "middle_name" => 100,
            "last_name" => 100,
            "suffix" => 30,
            "date_of_birth" => 10,
            "contact_number" => 40,
            "email" => 190,
            "address" => 190,
        ];
        foreach ($changes as $field => $value) {
            if (!is_scalar($value) || strlen(trim((string) $value)) > $fieldLimits[$field]) {
                $pdo->rollBack();
                respond(422, ["success" => false, "message" => "The requested profile field is too long or invalid."]);
            }
        }
        $columnMap = [
            "first_name" => "first_name",
            "middle_name" => "middle_name",
            "last_name" => "last_name",
            "suffix" => "suffix",
            "date_of_birth" => "date_of_birth",
            "contact_number" => "contact_number",
            "address" => "house_no_street",
        ];
        foreach ($columnMap as $key => $column) {
            if (array_key_exists($key, $changes)) {
                $value = trim((string) $changes[$key]);
                $residentChanges[$column] = $key === "date_of_birth" && $value === "" ? null : $value;
            }
        }
        foreach (["first_name", "middle_name", "last_name", "suffix"] as $nameField) {
            if (array_key_exists($nameField, $changes)) {
                $resident[$nameField] = trim((string) $changes[$nameField]);
            }
        }
        if (array_key_exists("email", $changes)) {
            $email = strtolower(trim((string) $changes["email"]));
            if ($email !== "" && (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 190)) {
                $pdo->rollBack();
                respond(422, ["success" => false, "message" => "Enter a valid email address."]);
            }
            if ($email !== "" && strcasecmp($email, (string) ($resident["email"] ?? "")) !== 0) {
                $duplicateEmail = $pdo->prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id <> ? LIMIT 1");
                $duplicateEmail->execute([$email, $resident["user_id"]]);
                if ($duplicateEmail->fetchColumn() !== false) {
                    $pdo->rollBack();
                    respond(409, ["success" => false, "message" => "This Gmail address is already linked to another account. Use a different email address."]);
                }
                $userChanges["email"] = $email;
            }
        }
        if (array_key_exists("date_of_birth", $changes) && !empty($residentChanges["date_of_birth"])) {
            $date = DateTime::createFromFormat("Y-m-d", $residentChanges["date_of_birth"]);
            if (!$date || $date->format("Y-m-d") !== $residentChanges["date_of_birth"]) {
                $pdo->rollBack();
                respond(422, ["success" => false, "message" => "Enter a valid date of birth."]);
            }
        }

        if ($residentChanges) {
            $assignments = implode(", ", array_map(fn($column) => "`$column` = ?", array_keys($residentChanges)));
            $updateResident = $pdo->prepare("UPDATE residents SET $assignments WHERE id = ?");
            $updateResident->execute([...array_values($residentChanges), $resident["id"]]);
        }
        $nameParts = array_filter(
            [$resident["first_name"], $resident["middle_name"], $resident["last_name"], $resident["suffix"]],
            fn($part) => trim((string) $part) !== ""
        );
        if (array_intersect(["first_name", "middle_name", "last_name", "suffix"], array_keys($changes))) {
            $userChanges["full_name"] = trim(implode(" ", $nameParts));
        }
        if ($userChanges) {
            $assignments = implode(", ", array_map(fn($column) => "`$column` = ?", array_keys($userChanges)));
            $updateUser = $pdo->prepare("UPDATE users SET $assignments WHERE id = ?");
            $updateUser->execute([...array_values($userChanges), $resident["user_id"]]);
        }
    }

    try {
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
        $description = $action === "set_status"
            ? "Resident account marked " . $status . " by an authorized official."
            : "Resident profile updated by an authorized official.";
        $historyStmt->execute([
            $resident["id"],
            $admin["id"],
            "resident_account_management",
            $description,
            "resident_account",
        ]);
    } catch (Throwable $historyError) {
        error_log("Resident account update history could not be recorded: " . $historyError->getMessage());
    }

    $pdo->commit();
    respond(200, [
        "success" => true,
        "message" => $action === "set_status"
            ? "Resident account status updated."
            : "Resident profile updated.",
    ]);
} catch (Throwable $error) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("Resident account admin error: " . $error->getMessage());
    respond(500, ["success" => false, "message" => "Unable to update the resident account. Please try again."]);
}
