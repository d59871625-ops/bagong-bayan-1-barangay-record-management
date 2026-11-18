<?php
require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

header("Content-Type: application/json; charset=utf-8");

if ($_SERVER["REQUEST_METHOD"] !== "GET") {
    http_response_code(405);
    echo json_encode([
        "success" => false,
        "message" => "Method not allowed. Use GET."
    ]);
    exit;
}

$user = authenticateUser($pdo, ["admin", "official", "resident"]);

try {
    if ($user["role"] === "resident") {
        $stmt = $pdo->prepare("
            SELECT
                id,
                title,
                content,
                status,
                published_at,
                created_at
            FROM announcements
            WHERE status = 'published'
            ORDER BY published_at DESC, id DESC
        ");
        $stmt->execute();
    } else {
        $stmt = $pdo->prepare("
            SELECT
                a.id,
                a.title,
                a.content,
                a.status,
                a.published_at,
                a.created_at,
                a.created_by,
                u.full_name AS created_by_name
            FROM announcements a
            LEFT JOIN users u ON a.created_by = u.id
            ORDER BY a.created_at DESC, a.id DESC
        ");
        $stmt->execute();
    }

    $announcements = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        "success" => true,
        "total" => count($announcements),
        "data" => $announcements
    ]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Failed to retrieve announcements."
    ]);
}
