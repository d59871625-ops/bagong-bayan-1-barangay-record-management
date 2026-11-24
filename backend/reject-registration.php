<?php

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";
require_once __DIR__ . "/registration-application-storage.php";

header("Content-Type: application/json");

function respond(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data, JSON_PRETTY_PRINT);
    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    respond(405, [
        "success" => false,
        "message" => "Method not allowed."
    ]);
}

try {
    $admin = authenticateUser($pdo, ["admin", "official"]);
    ensureRegistrationReferenceAccessTable($pdo);

    $input = json_decode(file_get_contents("php://input"), true);

    if (!is_array($input)) {
        respond(400, [
            "success" => false,
            "message" => "Invalid JSON request."
        ]);
    }

    $registrationId = filter_var(
        $input["registration_id"] ?? null,
        FILTER_VALIDATE_INT
    );

    $reason = trim($input["rejection_reason"] ?? "");

    if (!$registrationId || $registrationId < 1) {
        respond(422, [
            "success" => false,
            "message" => "A valid registration ID is required."
        ]);
    }

    if ($reason === "") {
        respond(422, [
            "success" => false,
            "message" => "Rejection reason is required."
        ]);
    }

    if (strlen($reason) > 1000) {
        respond(422, [
            "success" => false,
            "message" => "Rejection reason must not exceed 1000 characters."
        ]);
    }

    $pdo->beginTransaction();

    $stmt = $pdo->prepare("
        SELECT id, status
        FROM registration_requests
        WHERE id = ?
        FOR UPDATE
    ");

    $stmt->execute([$registrationId]);
    $registration = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$registration) {
        $pdo->rollBack();

        respond(404, [
            "success" => false,
            "message" => "Registration request not found."
        ]);
    }

    if ($registration["status"] !== "pending") {
        $pdo->rollBack();

        respond(409, [
            "success" => false,
            "message" => "This registration has already been reviewed."
        ]);
    }

    $stmt = $pdo->prepare("
        UPDATE registration_requests
        SET status = 'rejected',
            reviewed_by = ?,
            reviewed_at = NOW(),
            rejection_reason = ?
        WHERE id = ?
    ");

    $stmt->execute([
        $admin["id"],
        $reason,
        $registrationId
    ]);

    $clearPausedNote = $pdo->prepare("UPDATE registration_reference_access SET paused_note = NULL WHERE registration_id = ?");
    $clearPausedNote->execute([$registrationId]);

    $pdo->commit();

    respond(200, [
        "success" => true,
        "message" => "Resident registration rejected successfully.",
        "data" => [
            "registration_id" => $registrationId,
            "status" => "rejected",
            "reviewed_by" => $admin["id"],
            "rejection_reason" => $reason
        ]
    ]);

} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }

    error_log("Reject registration error: " . $e->getMessage());

    respond(500, [
        "success" => false,
        "message" => "An internal server error occurred."
    ]);
}
