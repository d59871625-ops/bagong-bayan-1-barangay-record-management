<?php
require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

header("Content-Type: application/json; charset=utf-8");

if ($_SERVER["REQUEST_METHOD"] !== "PUT") {
    http_response_code(405);
    echo json_encode([
        "success" => false,
        "message" => "Method not allowed. Use PUT."
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
$title = trim($data["title"] ?? "");
$content = trim($data["content"] ?? "");
$status = trim($data["status"] ?? "");

if (!$id || $id < 1) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "A valid announcement ID is required."
    ]);
    exit;
}

if ($title === "" || mb_strlen($title) > 200) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "Title is required and must not exceed 200 characters."
    ]);
    exit;
}

if ($content === "") {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "Announcement content is required."
    ]);
    exit;
}

if (!in_array($status, ["draft", "published", "archived"], true)) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "Invalid announcement status."
    ]);
    exit;
}

try {
    $check = $pdo->prepare("
        SELECT id, published_at
        FROM announcements
        WHERE id = ?
    ");
    $check->execute([$id]);
    $existing = $check->fetch(PDO::FETCH_ASSOC);

    if (!$existing) {
        http_response_code(404);
        echo json_encode([
            "success" => false,
            "message" => "Announcement not found."
        ]);
        exit;
    }

    $publishedAt = null;

    if ($status === "published") {
        $publishedAt = $existing["published_at"] ?? date("Y-m-d H:i:s");
    }

    $stmt = $pdo->prepare("
        UPDATE announcements
        SET
            title = ?,
            content = ?,
            status = ?,
            published_at = ?
        WHERE id = ?
    ");

    $stmt->execute([
        $title,
        $content,
        $status,
        $publishedAt,
        $id
    ]);

    echo json_encode([
        "success" => true,
        "message" => "Announcement updated successfully.",
        "data" => [
            "id" => (int) $id,
            "title" => $title,
            "content" => $content,
            "status" => $status,
            "published_at" => $publishedAt,
            "updated_by" => (int) $user["id"]
        ]
    ]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Failed to update announcement."
    ]);
}
