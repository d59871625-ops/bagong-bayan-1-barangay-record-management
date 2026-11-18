<?php
require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

header("Content-Type: application/json; charset=utf-8");

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    http_response_code(405);
    echo json_encode([
        "success" => false,
        "message" => "Method not allowed. Use POST."
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

$title = trim($data["title"] ?? "");
$content = trim($data["content"] ?? "");
$status = trim($data["status"] ?? "draft");

$allowedStatuses = ["draft", "published"];

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

if (!in_array($status, $allowedStatuses, true)) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "Invalid announcement status."
    ]);
    exit;
}

try {
    $publishedAt = $status === "published" ? date("Y-m-d H:i:s") : null;

    $stmt = $pdo->prepare("
        INSERT INTO announcements
            (title, content, status, created_by, published_at)
        VALUES
            (?, ?, ?, ?, ?)
    ");

    $stmt->execute([
        $title,
        $content,
        $status,
        $user["id"],
        $publishedAt
    ]);

    http_response_code(201);
    echo json_encode([
        "success" => true,
        "message" => "Announcement created successfully.",
        "data" => [
            "id" => (int) $pdo->lastInsertId(),
            "title" => $title,
            "content" => $content,
            "status" => $status,
            "created_by" => (int) $user["id"],
            "published_at" => $publishedAt
        ]
    ]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Failed to create announcement."
    ]);
}
