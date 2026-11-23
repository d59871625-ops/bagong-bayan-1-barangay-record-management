<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

function respond(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data);
    exit;
}

function residentNameKey(string $name): string
{
    $name = function_exists("mb_strtolower")
        ? mb_strtolower($name, "UTF-8")
        : strtolower($name);
    return preg_replace('/[^\p{L}\p{N}]+/u', '', $name) ?? "";
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    header("Allow: POST");
    respond(405, [
        "success" => false,
        "message" => "Method not allowed."
    ]);
}

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";
require_once __DIR__ . "/registration-application-storage.php";

$admin = authenticateUser($pdo, ["admin", "official"]);

$input = json_decode(file_get_contents("php://input"), true);

if (!is_array($input)) {
    respond(400, [
        "success" => false,
        "message" => "Invalid JSON request."
    ]);
}

$registrationId = filter_var(
    $input["registration_id"] ?? null,
    FILTER_VALIDATE_INT,
    ["options" => ["min_range" => 1]]
);

if (!$registrationId) {
    respond(422, [
        "success" => false,
        "message" => "A valid registration_id is required."
    ]);
}

try {
    ensureRegistrationReferenceAccessTable($pdo);
    $pdo->beginTransaction();

    $requestStmt = $pdo->prepare("
        SELECT *
        FROM registration_requests
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
    ");

    $requestStmt->execute([$registrationId]);
    $application = $requestStmt->fetch(PDO::FETCH_ASSOC);

    if (!$application) {
        $pdo->rollBack();
        respond(404, [
            "success" => false,
            "message" => "Registration application not found."
        ]);
    }

    if ($application["status"] !== "pending") {
        $pdo->rollBack();
        respond(409, [
            "success" => false,
            "message" => "This registration has already been reviewed."
        ]);
    }

    $duplicateStmt = $pdo->prepare("
        SELECT id
        FROM users
        WHERE email = ?
        LIMIT 1
    ");

    $duplicateStmt->execute([$application["email"]]);

    if ($duplicateStmt->fetch()) {
        $pdo->rollBack();
        respond(409, [
            "success" => false,
            "message" => "An account with this email already exists."
        ]);
    }

    $firstInitial = strtoupper(
        substr(preg_replace('/[^A-Za-z]/', '', $application["first_name"]), 0, 1)
    );

    $lastInitial = strtoupper(
        substr(preg_replace('/[^A-Za-z]/', '', $application["last_name"]), 0, 1)
    );

    if ($firstInitial === "" || $lastInitial === "") {
        $pdo->rollBack();
        respond(422, [
            "success" => false,
            "message" => "The applicant name cannot generate a resident code."
        ]);
    }

    $sequenceStmt = $pdo->query("
        SELECT id, next_number
        FROM resident_code_sequence
        WHERE id = 1
        FOR UPDATE
    ");

    $sequence = $sequenceStmt->fetch(PDO::FETCH_ASSOC);

    if (!$sequence) {
        throw new RuntimeException("Resident code sequence is not initialized.");
    }

    $number = (int) $sequence["next_number"];

    if ($number < 1 || $number > 999) {
        throw new RuntimeException("Resident code sequence is out of range.");
    }

    $residentCode = sprintf(
        "BB1-%s%s-%03d",
        $firstInitial,
        $lastInitial,
        $number
    );

    $fullNameParts = [
        $application["first_name"],
        $application["middle_name"],
        $application["last_name"],
        $application["suffix"]
    ];

    $fullName = trim(implode(" ", array_filter(
        $fullNameParts,
        fn($part) => $part !== null && trim($part) !== ""
    )));

    $residentNameKey = residentNameKey($fullName);
    $residentsStmt = $pdo->query("
        SELECT first_name, middle_name, last_name, suffix
        FROM residents
        FOR UPDATE
    ");
    foreach ($residentsStmt->fetchAll(PDO::FETCH_ASSOC) as $resident) {
        $existingName = trim(implode(" ", array_filter(
            [
                $resident["first_name"] ?? "",
                $resident["middle_name"] ?? "",
                $resident["last_name"] ?? "",
                $resident["suffix"] ?? ""
            ],
            fn($part) => $part !== null && trim((string) $part) !== ""
        )));
        if ($residentNameKey !== "" && residentNameKey($existingName) === $residentNameKey) {
            $pdo->rollBack();
            respond(409, [
                "success" => false,
                "message" => "A resident with this name already exists. This registration cannot create another resident record."
            ]);
        }
    }

    $userStmt = $pdo->prepare("
        INSERT INTO users (
            full_name,
            email,
            password_hash,
            role,
            account_status
        )
        VALUES (?, ?, ?, 'resident', 'active')
    ");

    $userStmt->execute([
        $fullName,
        $application["email"],
        $application["password_hash"]
    ]);

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
            sex,
            civil_status,
            contact_number,
            house_no_street,
            purok,
            barangay,
            city_municipality,
            province,
            record_status
        )
        VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active'
        )
    ");

    $residentStmt->execute([
        $userId,
        $residentCode,
        $application["first_name"],
        $application["middle_name"],
        $application["last_name"],
        $application["suffix"],
        $application["date_of_birth"],
        $application["sex"],
        $application["civil_status"],
        $application["contact_number"],
        $application["house_no_street"],
        $application["purok"],
        $application["barangay"],
        $application["city_municipality"],
        $application["province"]
    ]);

    $residentId = (int) $pdo->lastInsertId();

    $updateRequest = $pdo->prepare("
        UPDATE registration_requests
        SET status = 'approved',
            reviewed_by = ?,
            reviewed_at = NOW()
        WHERE id = ?
    ");

    $updateRequest->execute([
        $admin["id"],
        $registrationId
    ]);

    $referenceAccessStmt = $pdo->prepare("INSERT INTO registration_reference_access (registration_id, resident_code)
        VALUES (?, ?) ON DUPLICATE KEY UPDATE resident_code = VALUES(resident_code)");
    $referenceAccessStmt->execute([$registrationId, $residentCode]);

    $historyStmt = $pdo->prepare("
        INSERT INTO resident_history (
            resident_id,
            user_id,
            transaction_type,
            description,
            reference_type,
            reference_id
        )
        VALUES (?, ?, ?, ?, ?, ?)
    ");

    $historyStmt->execute([
        $residentId,
        $admin["id"],
        "registration_approved",
        "Resident registration approved. Assigned resident code: " . $residentCode,
        "registration_request",
        $registrationId
    ]);

    $updateSequence = $pdo->prepare("
        UPDATE resident_code_sequence
        SET next_number = ?
        WHERE id = 1
    ");

    $updateSequence->execute([$number + 1]);

    $pdo->commit();

    respond(200, [
        "success" => true,
        "message" => "Resident registration approved successfully.",
        "data" => [
            "registration_id" => (int) $registrationId,
            "user_id" => $userId,
            "resident_id" => $residentId,
            "resident_code" => $residentCode,
            "full_name" => $fullName,
            "email" => $application["email"],
            "role" => "resident",
            "account_status" => "active"
        ]
    ]);

} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }

    error_log("Approve registration error: " . $e->getMessage());

    respond(500, [
        "success" => false,
        "message" => "Unable to approve this registration."
    ]);
}
