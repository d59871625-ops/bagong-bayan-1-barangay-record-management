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
require_once __DIR__ . "/registration-application-storage.php";

$admin = authenticateUser($pdo, ["admin", "official"]);

try {
    ensureRegistrationApplicationDetailsTable($pdo);
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
            registration_requests.created_at,
            details.application_data,
            details.valid_id,
            details.proof_of_residence
        FROM registration_requests
        LEFT JOIN registration_application_details AS details
            ON details.registration_id = registration_requests.id
        WHERE status = 'pending'
        ORDER BY registration_requests.created_at ASC
    ");

    $applications = $stmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($applications as &$application) {
        if ($application["application_data"] !== null) {
            $application["application_data"] = decodeRegistrationApplicationJson($application["application_data"], "data");
            $application["valid_id"] = decodeRegistrationApplicationJson($application["valid_id"], "valid ID");
            $application["proof_of_residence"] = decodeRegistrationApplicationJson($application["proof_of_residence"], "proof of residence");
        }
    }
    unset($application);

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