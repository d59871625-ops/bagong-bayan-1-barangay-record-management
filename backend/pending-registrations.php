<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
header("Pragma: no-cache");
header("Expires: 0");

if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") {
    require_once __DIR__ . "/db.php";
    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "GET") {
    header("Allow: GET");
    http_response_code(405);
    echo json_encode([
        "success" => false,
        "message" => "Method not allowed."
    ]);
    exit;
}

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

$admin = authenticateUser($pdo, ["admin", "official"]);

try {
    $stmt = $pdo->query("
        SELECT
            id,
            first_name,
            middle_name,
            last_name,
            suffix,
            email,
            date_of_birth,
            sex,
            civil_status,
            contact_number,
            house_no_street,
            purok,
            barangay,
            city_municipality,
            province,
            status,
            created_at
        FROM registration_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC
    ");

    $applications = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        "success" => true,
        "message" => "Pending registrations retrieved successfully.",
        "total" => count($applications),
        "data" => $applications
    ]);

} catch (Throwable $e) {
    error_log("Pending registrations error: " . $e->getMessage());

    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Unable to retrieve pending registrations."
    ]);
}