<?php

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

header("Content-Type: application/json");

function respond(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data, JSON_PRETTY_PRINT);
    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "GET") {
    respond(405, [
        "success" => false,
        "message" => "Method not allowed."
    ]);
}

try {
    $user = authenticateUser($pdo, ["resident"]);

    $stmt = $pdo->prepare("
        SELECT
            r.id AS resident_id,
            r.resident_code,
            r.first_name,
            r.middle_name,
            r.last_name,
            r.suffix,
            r.date_of_birth,
            r.sex,
            r.civil_status,
            r.contact_number,
            r.house_no_street,
            r.purok,
            r.barangay,
            r.city_municipality,
            r.province,
            r.record_status,
            u.full_name,
            u.email,
            u.account_status
        FROM residents r
        INNER JOIN users u ON u.id = r.user_id
        WHERE r.user_id = ?
        LIMIT 1
    ");

    $stmt->execute([$user["id"]]);
    $resident = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$resident) {
        respond(404, [
            "success" => false,
            "message" => "Resident profile not found."
        ]);
    }

    respond(200, [
        "success" => true,
        "message" => "Resident profile retrieved successfully.",
        "data" => $resident
    ]);

} catch (Throwable $e) {
    error_log("Resident profile error: " . $e->getMessage());

    respond(500, [
        "success" => false,
        "message" => "An internal server error occurred."
    ]);
}