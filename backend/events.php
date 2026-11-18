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
                description,
                event_date,
                start_time,
                end_time,
                location,
                status,
                created_at
            FROM events
            WHERE status = 'planned'
            ORDER BY event_date ASC, start_time ASC, id ASC
        ");
    } else {
        $stmt = $pdo->prepare("
            SELECT
                e.id,
                e.title,
                e.description,
                e.event_date,
                e.start_time,
                e.end_time,
                e.location,
                e.status,
                e.created_by,
                e.created_at,
                u.full_name AS created_by_name
            FROM events e
            LEFT JOIN users u ON e.created_by = u.id
            ORDER BY e.event_date ASC, e.start_time ASC, e.id ASC
        ");
    }

    $stmt->execute();
    $events = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        "success" => true,
        "total" => count($events),
        "data" => $events
    ]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Failed to retrieve events."
    ]);
}
