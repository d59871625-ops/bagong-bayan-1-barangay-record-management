<?php

require_once __DIR__ . "/db.php";

header("Content-Type: application/json");

function respond(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data, JSON_PRETTY_PRINT);
    exit;
}

function residentNameTokens(string $value): array
{
    $tokens = preg_split('/\s+/', strtolower(trim($value))) ?: [];
    return array_values(array_filter(array_map(
        fn($token) => preg_replace('/[^a-z0-9]/', '', $token),
        $tokens
    )));
}

function findTokenSequence(array $tokens, array $sequence, int $start, ?int $end = null): int
{
    $end ??= count($tokens);
    for ($index = $start; $index <= $end - count($sequence); $index++) {
        if (array_slice($tokens, $index, count($sequence)) === $sequence) {
            return $index;
        }
    }

    return -1;
}

function residentNameMatches(array $resident, array $input): bool
{
    $registeredTokens = residentNameTokens(implode(" ", array_filter(
        [
            $resident["first_name"],
            $resident["middle_name"],
            $resident["last_name"],
            $resident["suffix"]
        ],
        fn($part) => $part !== null && trim((string) $part) !== ""
    )));
    $firstTokens = residentNameTokens($input["first_name"]);
    $middleTokens = residentNameTokens($input["middle_name"]);
    $lastTokens = residentNameTokens($input["last_name"]);
    $suffixTokens = residentNameTokens($input["suffix"]);

    if (!$firstTokens || !$lastTokens || array_slice($registeredTokens, 0, count($firstTokens)) !== $firstTokens) {
        return false;
    }

    $firstEnd = count($firstTokens);
    $lastStart = findTokenSequence($registeredTokens, $lastTokens, $firstEnd);

    if ($lastStart < 0) {
        return false;
    }

    if ($middleTokens && findTokenSequence($registeredTokens, $middleTokens, $firstEnd, $lastStart) < 0) {
        return false;
    }

    return !$suffixTokens
        || findTokenSequence($registeredTokens, $suffixTokens, $lastStart + count($lastTokens)) >= 0;
}

function findResidentAccount(PDO $pdo, string $residentCode): ?array
{
    $stmt = $pdo->prepare("
        SELECT
            u.id,
            u.full_name,
            u.email,
            u.role,
            u.account_status,
            r.id AS resident_id,
            r.resident_code,
            r.first_name,
            r.middle_name,
            r.last_name,
            r.suffix,
            r.record_status
        FROM residents r
        INNER JOIN users u ON u.id = r.user_id
        WHERE r.resident_code = ?
        LIMIT 1
    ");
    $stmt->execute([$residentCode]);
    $resident = $stmt->fetch(PDO::FETCH_ASSOC);
    return $resident ?: null;
}

function residentDirectoryNameParts(stdClass $record): ?array
{
    $parts = [];
    foreach (["firstName", "middleName", "lastName", "suffix"] as $field) {
        $parts[$field] = isset($record->{$field}) && is_string($record->{$field})
            ? trim($record->{$field})
            : "";
    }

    $fullName = "";
    foreach (["name", "fullName", "full_name"] as $field) {
        if (isset($record->{$field}) && is_string($record->{$field}) && trim($record->{$field}) !== "") {
            $fullName = trim($record->{$field});
            break;
        }
    }

    if ($parts["firstName"] === "" || $parts["lastName"] === "") {
        if ($fullName === "") {
            $fullName = trim(implode(" ", array_filter($parts)));
        }
        $nameParts = preg_split('/\s+/', $fullName, -1, PREG_SPLIT_NO_EMPTY) ?: [];
        if (count($nameParts) < 2) return null;

        $suffix = strtoupper(rtrim($nameParts[count($nameParts) - 1], "."));
        if (in_array($suffix, ["JR", "SR", "II", "III", "IV", "V"], true)) {
            $parts["suffix"] = $nameParts[count($nameParts) - 1];
            array_pop($nameParts);
        }
        $parts["firstName"] = array_shift($nameParts) ?? "";
        $parts["lastName"] = array_pop($nameParts) ?? "";
        $parts["middleName"] = implode(" ", $nameParts);
    }

    if ($parts["firstName"] === "" || $parts["lastName"] === "") return null;
    if ($fullName === "") $fullName = trim(implode(" ", array_filter($parts)));

    return [
        "first_name" => $parts["firstName"],
        "middle_name" => $parts["middleName"] !== "" ? $parts["middleName"] : null,
        "last_name" => $parts["lastName"],
        "suffix" => $parts["suffix"] !== "" ? $parts["suffix"] : null,
        "full_name" => $fullName,
    ];
}

function getActiveResidentDirectoryRecord(PDO $pdo, string $residentCode): ?array
{
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS bb1_app_state (
            data_key VARCHAR(100) NOT NULL PRIMARY KEY,
            data_value LONGTEXT NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $stmt = $pdo->prepare("
        SELECT data_value
        FROM bb1_app_state
        WHERE data_key = ?
        LIMIT 1
        FOR UPDATE
    ");
    $stmt->execute(["bb1-resident-records"]);
    $savedRecords = $stmt->fetchColumn();
    if ($savedRecords === false) return null;

    $records = json_decode((string) $savedRecords, false, 512, JSON_THROW_ON_ERROR);
    if (!is_array($records)) {
        throw new RuntimeException("Saved resident records are not a list.");
    }

    $match = null;
    foreach ($records as $record) {
        if (!($record instanceof stdClass)) continue;
        $recordCode = "";
        foreach (["code", "residentCode", "resident_code"] as $field) {
            if (isset($record->{$field}) && (is_string($record->{$field}) || is_int($record->{$field}))) {
                $recordCode = strtoupper(trim((string) $record->{$field}));
                break;
            }
        }
        if ($recordCode !== $residentCode) continue;
        if ($match !== null) {
            throw new RuntimeException("The saved resident directory contains duplicate resident codes.");
        }

        $status = strtolower(trim((string) ($record->recordStatus ?? $record->record_status ?? "active")));
        if ($status !== "" && $status !== "active") return null;
        $nameParts = residentDirectoryNameParts($record);
        if (!$nameParts) return null;

        $match = [
            ...$nameParts,
            "date_of_birth" => $record->birthDate ?? $record->dateOfBirth ?? $record->date_of_birth ?? null,
            "contact_number" => $record->contactNumber ?? $record->mobileNumber ?? $record->contact_number ?? null,
            "house_no_street" => $record->address ?? $record->house_no_street ?? null,
        ];
    }

    return $match;
}

function ensureResidentAccountFromDirectory(PDO $pdo, string $residentCode, array $nameInput): ?array
{
    if (!preg_match('/^BB1-[A-Z0-9]{1,8}-\d{3}$/', $residentCode)) return null;

    $pdo->beginTransaction();
    try {
        $directoryRecord = getActiveResidentDirectoryRecord($pdo, $residentCode);
        if (!$directoryRecord || !residentNameMatches($directoryRecord, $nameInput)) {
            $pdo->rollBack();
            return null;
        }

        $resident = findResidentAccount($pdo, $residentCode);
        if ($resident) {
            if ($resident["record_status"] === "active" && $resident["account_status"] === "active"
                && !residentNameMatches($resident, $nameInput)) {
                $updateResident = $pdo->prepare("
                    UPDATE residents
                    SET first_name = ?, middle_name = ?, last_name = ?, suffix = ?
                    WHERE id = ?
                ");
                $updateResident->execute([
                    $directoryRecord["first_name"],
                    $directoryRecord["middle_name"],
                    $directoryRecord["last_name"],
                    $directoryRecord["suffix"],
                    $resident["resident_id"],
                ]);
                $updateUser = $pdo->prepare("UPDATE users SET full_name = ? WHERE id = ?");
                $updateUser->execute([$directoryRecord["full_name"], $resident["id"]]);
                $resident = findResidentAccount($pdo, $residentCode);
            }
            $pdo->commit();
            return $resident;
        }

        $dateOfBirth = is_string($directoryRecord["date_of_birth"])
            ? trim($directoryRecord["date_of_birth"])
            : "";
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateOfBirth)) {
            $dateOfBirth = null;
        } else {
            [$year, $month, $day] = array_map("intval", explode("-", $dateOfBirth));
            if (!checkdate($month, $day, $year)) $dateOfBirth = null;
        }
        $contactNumber = is_string($directoryRecord["contact_number"])
            ? trim($directoryRecord["contact_number"])
            : "";
        $address = is_string($directoryRecord["house_no_street"])
            ? trim($directoryRecord["house_no_street"])
            : "";
        $unusablePasswordHash = password_hash(bin2hex(random_bytes(32)), PASSWORD_DEFAULT);
        if ($unusablePasswordHash === false) {
            throw new RuntimeException("Unable to create the resident account credential.");
        }

        $userStmt = $pdo->prepare("
            INSERT INTO users (full_name, email, password_hash, role, account_status)
            VALUES (?, NULL, ?, 'resident', 'active')
        ");
        $userStmt->execute([$directoryRecord["full_name"], $unusablePasswordHash]);
        $userId = (int) $pdo->lastInsertId();

        $residentStmt = $pdo->prepare("
            INSERT INTO residents (
                user_id,
                resident_code,
                first_name,
                middle_name,
                last_name,
                suffix,
                date_of_birth,
                contact_number,
                house_no_street,
                record_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        ");
        $residentStmt->execute([
            $userId,
            $residentCode,
            $directoryRecord["first_name"],
            $directoryRecord["middle_name"],
            $directoryRecord["last_name"],
            $directoryRecord["suffix"],
            $dateOfBirth,
            $contactNumber !== "" ? $contactNumber : null,
            $address !== "" ? $address : null,
        ]);

        $resident = findResidentAccount($pdo, $residentCode);
        if (!$resident) {
            throw new RuntimeException("The resident account could not be retrieved after creation.");
        }
        $pdo->commit();
        return $resident;
    } catch (PDOException $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        if ($error->getCode() === "23000") {
            $resident = findResidentAccount($pdo, $residentCode);
            if ($resident) return $resident;
        }
        throw $error;
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    respond(405, [
        "success" => false,
        "message" => "Method not allowed."
    ]);
}

$input = json_decode(file_get_contents("php://input"), true);

if (!is_array($input)) {
    respond(400, [
        "success" => false,
        "message" => "Invalid JSON request."
    ]);
}

$residentCodeValue = $input["resident_code"] ?? "";
if (!is_string($residentCodeValue)) {
    respond(422, [
        "success" => false,
        "message" => "Resident details are invalid."
    ]);
}

$residentCode = strtoupper(trim($residentCodeValue));
$nameInput = [
    "first_name" => "",
    "middle_name" => "",
    "last_name" => "",
    "suffix" => ""
];
foreach (array_keys($nameInput) as $field) {
    $value = $input[$field] ?? "";
    if (!is_string($value)) {
        respond(422, [
            "success" => false,
            "message" => "Resident details are invalid."
        ]);
    }
    $nameInput[$field] = trim($value);
}

if ($residentCode === "" || $nameInput["first_name"] === "" || $nameInput["last_name"] === "") {
    respond(422, [
        "success" => false,
        "message" => "First name, last name, and resident code are required."
    ]);
}

try {
    $resident = findResidentAccount($pdo, $residentCode);
    if (!$resident || !residentNameMatches($resident, $nameInput)) {
        $resident = ensureResidentAccountFromDirectory($pdo, $residentCode, $nameInput);
    }

    if (!$resident
        || $resident["record_status"] !== "active"
        || $resident["role"] !== "resident"
        || $resident["account_status"] !== "active"
        || !residentNameMatches($resident, $nameInput)) {
        respond(401, [
            "success" => false,
            "message" => "Invalid resident details or inactive account."
        ]);
    }

    $token = bin2hex(random_bytes(32));
    $tokenHash = hash("sha256", $token);

    $expiresAt = date(
        "Y-m-d H:i:s",
        time() + (30 * 24 * 60 * 60)
    );

    $stmt = $pdo->prepare("
        INSERT INTO api_tokens
            (user_id, token_hash, created_at, expires_at)
        VALUES (?, ?, NOW(), ?)
    ");

    $stmt->execute([
        $resident["id"],
        $tokenHash,
        $expiresAt
    ]);

    respond(200, [
        "success" => true,
        "message" => "Resident login successful.",
        "token" => $token,
        "data" => [
            "id" => (int) $resident["id"],
            "resident_id" => (int) $resident["resident_id"],
            "full_name" => $resident["full_name"],
            "resident_code" => $resident["resident_code"],
            "role" => $resident["role"],
            "account_status" => $resident["account_status"]
        ]
    ]);

} catch (Throwable $e) {
    error_log("Resident login error: " . $e->getMessage());

    respond(500, [
        "success" => false,
        "message" => "An internal server error occurred."
    ]);
}