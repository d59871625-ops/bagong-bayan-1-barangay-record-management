<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";
require_once __DIR__ . "/registration-application-storage.php";

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    header("Allow: POST");
    respond(405, ["success" => false, "message" => "Method not allowed."]);
}

$admin = authenticateUser($pdo, ["admin", "official"]);
$input = json_decode(file_get_contents("php://input"), true);
$registrationId = is_array($input)
    ? filter_var($input["registration_id"] ?? null, FILTER_VALIDATE_INT, ["options" => ["min_range" => 1]])
    : false;
$action = is_array($input) && is_string($input["action"] ?? null) ? trim($input["action"]) : "pause";
$note = is_array($input) && is_string($input["note"] ?? null) ? trim($input["note"]) : "";
if (!$registrationId || !in_array($action, ["pause", "resume"], true)
    || ($action === "pause" && ($note === "" || strlen($note) > 1000))) {
    respond(422, ["success" => false, "message" => "A valid registration ID and, when pausing, a note of up to 1000 characters are required."]);
}

try {
    ensureRegistrationReferenceAccessTable($pdo);
    $pdo->beginTransaction();
    $request = $pdo->prepare("SELECT id, status FROM registration_requests WHERE id = ? LIMIT 1 FOR UPDATE");
    $request->execute([$registrationId]);
    $registration = $request->fetch(PDO::FETCH_ASSOC);
    if (!$registration) {
        $pdo->rollBack();
        respond(404, ["success" => false, "message" => "Registration application not found."]);
    }
    if (strtolower((string) $registration["status"]) !== "pending") {
        $pdo->rollBack();
        respond(409, ["success" => false, "message" => "Only pending registrations can be returned for edits."]);
    }
    if ($action === "pause") {
        $save = $pdo->prepare("INSERT INTO registration_reference_access (registration_id, paused_note)
            VALUES (?, ?) ON DUPLICATE KEY UPDATE paused_note = VALUES(paused_note)");
        $save->execute([$registrationId, $note]);
    } else {
        $clear = $pdo->prepare("UPDATE registration_reference_access SET paused_note = NULL WHERE registration_id = ?");
        $clear->execute([$registrationId]);
    }
    $pdo->commit();
    respond(200, ["success" => true, "message" => $action === "pause" ? "The edit note was saved." : "The returned note was cleared.", "data" => [
        "registration_id" => (int) $registrationId,
        "status" => $action === "pause" ? "Paused" : "Pending",
        "updated_by" => $admin["id"],
    ]]);
} catch (Throwable $error) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("Pause registration error: " . $error->getMessage());
    respond(500, ["success" => false, "message" => "Unable to save the registration edit note."]);
}
