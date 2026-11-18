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

$user = authenticateUser($pdo, ["admin", "official"]);

try {
    $stmt = $pdo->query("
        SELECT
            dr.id,
            dr.resident_id,
            dr.document_type,
            dr.purpose,
            dr.status,
            dr.processed_by,
            dr.remarks,
            r.resident_code,
            r.first_name,
            r.middle_name,
            r.last_name,
            r.suffix,
            r.contact_number,
            r.purok,
            r.barangay,
            u.email,
            dr.created_at
        FROM document_requests dr
        INNER JOIN residents r
            ON dr.resident_id = r.id
        INNER JOIN users u
            ON r.user_id = u.id
        ORDER BY dr.created_at DESC, dr.id DESC
    ");

    $requests = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        "success" => true,
        "message" => "Document requests retrieved successfully.",
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
