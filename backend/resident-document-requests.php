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

$user = authenticateUser($pdo, ["resident"]);

try {
    $residentStmt = $pdo->prepare("
        SELECT id
        FROM residents
        WHERE user_id = ?
          AND record_status = 'active'
        LIMIT 1
    ");

    $residentStmt->execute([$user["id"]]);
    $resident = $residentStmt->fetch(PDO::FETCH_ASSOC);

    if (!$resident) {
        http_response_code(404);
        echo json_encode([
            "success" => false,
            "message" => "Active resident profile not found."
        ]);
        exit;
    }

    $stmt = $pdo->prepare("
        SELECT
            id,
            document_type,
            purpose,
            status,
            remarks,
            created_at
        FROM document_requests
        WHERE resident_id = ?
        ORDER BY created_at DESC, id DESC
    ");

    $stmt->execute([$resident["id"]]);
    $requests = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        "success" => true,
        "message" => "Resident document requests retrieved successfully.",
        "data" => [
            "total" => count($requests),
            "requests" => $requests
        ]
    ]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Failed to retrieve document requests."
    ]);
}
