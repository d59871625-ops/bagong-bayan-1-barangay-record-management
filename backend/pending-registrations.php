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
    $versionStatement = $pdo->query("
        SELECT id, status, created_at, reviewed_at, rejection_reason
        FROM registration_requests
        ORDER BY created_at ASC, id ASC
    ");
    $versionRows = $versionStatement->fetchAll(PDO::FETCH_ASSOC);
    $etagContext = hash_init("sha256");
    foreach ($versionRows as $versionRow) {
        hash_update(
            $etagContext,
            (string) $versionRow["id"] . "\0"
                . (string) $versionRow["status"] . "\0"
                . (string) $versionRow["created_at"] . "\0"
                . (string) ($versionRow["reviewed_at"] ?? "") . "\0"
                . (string) ($versionRow["rejection_reason"] ?? "") . "\0"
        );
    }
    $etag = '"' . hash_final($etagContext) . '"';
    header("ETag: " . $etag);
    $clientEtag = trim($_SERVER["HTTP_IF_NONE_MATCH"] ?? "");
    if ($clientEtag !== "" && hash_equals($etag, $clientEtag)) {
        http_response_code(304);
        exit;
    }

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

    $historyStatement = $pdo->query("
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
            created_at,
            reviewed_at,
            rejection_reason
        FROM registration_requests
        WHERE status IN ('approved', 'rejected')
        ORDER BY created_at DESC, id DESC
    ");
    $history = $historyStatement->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        "success" => true,
        "message" => "Registration requests retrieved successfully.",
        "total" => count($applications),
        "data" => $applications,
        "history" => $history
    ]);

} catch (Throwable $e) {
    error_log("Pending registrations error: " . $e->getMessage());

    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Unable to retrieve pending registrations."
    ]);
}