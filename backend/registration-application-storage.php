<?php

function ensureRegistrationApplicationDetailsTable(PDO $pdo): void
{
    $emailColumnStmt = $pdo->prepare("
        SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, CHARACTER_SET_NAME, COLLATION_NAME, IS_NULLABLE
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'registration_requests'
          AND COLUMN_NAME = 'email'
        LIMIT 1
    ");
    $emailColumnStmt->execute();
    $emailColumn = $emailColumnStmt->fetch(PDO::FETCH_ASSOC);
    if ($emailColumn && $emailColumn["IS_NULLABLE"] !== "YES") {
        if (strtolower((string) $emailColumn["DATA_TYPE"]) !== "varchar") {
            throw new RuntimeException("The registration email column has an unsupported database type.");
        }
        $emailLength = filter_var($emailColumn["CHARACTER_MAXIMUM_LENGTH"], FILTER_VALIDATE_INT, ["options" => ["min_range" => 1]]);
        if (!$emailLength) {
            throw new RuntimeException("The registration email column has an invalid database length.");
        }
        $characterSet = (string) ($emailColumn["CHARACTER_SET_NAME"] ?? "");
        $collation = (string) ($emailColumn["COLLATION_NAME"] ?? "");
        if (!preg_match('/^[A-Za-z0-9_]+$/', $characterSet) || !preg_match('/^[A-Za-z0-9_]+$/', $collation)) {
            throw new RuntimeException("The registration email column has invalid character settings.");
        }
        $pdo->exec(
            "ALTER TABLE registration_requests MODIFY COLUMN email VARCHAR(" . $emailLength . ")"
            . " CHARACTER SET " . $characterSet . " COLLATE " . $collation . " NULL"
        );
    }

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS registration_application_details (
            registration_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
            submission_key VARCHAR(64) NOT NULL UNIQUE,
            application_data LONGTEXT NOT NULL,
            valid_id LONGTEXT NOT NULL,
            proof_of_residence LONGTEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $updatedAtColumnStmt = $pdo->prepare("SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'registration_application_details'
          AND COLUMN_NAME = 'updated_at' LIMIT 1");
    $updatedAtColumnStmt->execute();
    if (!$updatedAtColumnStmt->fetchColumn()) {
        $pdo->exec("ALTER TABLE registration_application_details
            ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
    }
}

function ensureRegistrationReferenceAccessTable(PDO $pdo): void
{
    $pdo->exec("CREATE TABLE IF NOT EXISTS registration_reference_access (
        registration_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
        resident_code VARCHAR(32) NULL,
        paused_note TEXT NULL,
        declined_notice_acknowledged_at TIMESTAMP NULL DEFAULT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $columnStmt = $pdo->prepare("SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'registration_reference_access'
          AND COLUMN_NAME = 'paused_note' LIMIT 1");
    $columnStmt->execute();
    if (!$columnStmt->fetchColumn()) {
        $pdo->exec("ALTER TABLE registration_reference_access ADD COLUMN paused_note TEXT NULL AFTER resident_code");
    }
}

function decodeRegistrationApplicationJson(?string $value, string $field): array
{
    $decoded = json_decode((string) $value, true);
    if (!is_array($decoded)) {
        throw new RuntimeException("Saved registration {$field} is invalid.");
    }

    return $decoded;
}
