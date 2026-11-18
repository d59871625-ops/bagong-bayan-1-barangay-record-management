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
        "message" => "A valid announcement ID is required."
    ]);
    exit;
}

try {
    $check = $pdo->prepare("
        SELECT id, title
        FROM announcements
        WHERE id = ?
    ");
    $check->execute([$id]);

    $announcement = $check->fetch(PDO::FETCH_ASSOC);

    if (!$announcement) {
        http_response_code(404);
        echo json_encode([
            "success" => false,
            "message" => "Announcement not found."
        ]);
        exit;
    }

    $stmt = $pdo->prepare("
        DELETE FROM announcements
        WHERE id = ?
    ");
    $stmt->execute([$id]);

    echo json_encode([
        "success" => true,
        "message" => "Announcement deleted successfully.",
        "data" => [
            "id" => (int) $id,
            "title" => $announcement["title"],
            "deleted_by" => (int) $user["id"]
        ]
    ]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Failed to delete announcement."
    ]);
}
