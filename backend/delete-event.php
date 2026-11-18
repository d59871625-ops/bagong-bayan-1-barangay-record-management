<?php
require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

header("Content-Type: application/json; charset=utf-8");

if ($_SERVER["REQUEST_METHOD"] !== "DELETE") {
    http_response_code(405);
    echo json_encode([
        "success" => false,
        "message" => "Method not allowed. Use DELETE."
    ]);
    exit;
}

$user = authenticateUser($pdo, ["admin", "official"]);

$data = json_decode(file_get_contents("php://input"), true);

if (!is_array($data)) {
    http_response_code(400);
    echo json_encode([
        "success" => false,
        "message" => "Invalid JSON request."
    ]);
    exit;
}

$id = filter_var($data["id"] ?? null, FILTER_VALIDATE_INT);

if (!$id || $id < 1) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "A valid event ID is required."
    ]);
    exit;
}

try {
    $check = $pdo->prepare("SELECT id FROM events WHERE id = ?");
    $check->execute([$id]);

    if (!$check->fetch()) {
        http_response_code(404);
        echo json_encode([
            "success" => false,
            "message" => "Event not found."
        ]);
        exit;
    }

    $stmt = $pdo->prepare("DELETE FROM events WHERE id = ?");
    $stmt->execute([$id]);

    echo json_encode([
        "success" => true,
        "message" => "Event deleted successfully.",
        "deleted_event_id" => (int) $id,
        "deleted_by" => (int) $user["id"]
    ]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Failed to delete event."
    ]);
}
