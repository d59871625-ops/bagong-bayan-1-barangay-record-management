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
    ensureRegistrationReferenceAccessTable($pdo);
    $versionStatement = $pdo->query("
        SELECT r.id, r.status, r.created_at, r.reviewed_at, r.rejection_reason, access.paused_note
        FROM registration_requests AS r
        LEFT JOIN registration_reference_access AS access ON access.registration_id = r.id
        ORDER BY r.created_at ASC, r.id ASC
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
                . (string) ($versionRow["paused_note"] ?? "") . "\0"
        );
    }
    $etag = '"' . hash_final($etagContext) . '"';
    header("ETag: " . $etag);
    $clientEtag = trim($_SERVER["HTTP_IF_NONE_MATCH"] ?? "");
    if ($clientEtag !== "" && hash_equals($etag, $clientEtag)) {
        http_response_code(304);
        exit;
    }

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
            details.proof_of_residence,
            reference_access.paused_note AS reference_access_note
        FROM registration_requests
        LEFT JOIN registration_application_details AS details
            ON details.registration_id = registration_requests.id
        LEFT JOIN registration_reference_access AS reference_access
            ON reference_access.registration_id = registration_requests.id
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
            registration_requests.id,
            registration_requests.first_name,
            registration_requests.middle_name,
            registration_requests.last_name,
            registration_requests.suffix,
            registration_requests.email,
            registration_requests.date_of_birth,
            registration_requests.sex,
            registration_requests.civil_status,
            registration_requests.contact_number,
            registration_requests.house_no_street,
            registration_requests.purok,
            registration_requests.barangay,
            registration_requests.city_municipality,
            registration_requests.province,
            registration_requests.status,
            registration_requests.created_at,
            registration_requests.reviewed_at,
            registration_requests.rejection_reason,
            COALESCE(reference_access.resident_code, resident.resident_code) AS assigned_resident_code,
            resident.id AS resident_id,
            resident.record_status AS resident_record_status,
            resident.first_name AS resident_first_name,
            resident.middle_name AS resident_middle_name,
            resident.last_name AS resident_last_name,
            resident.suffix AS resident_suffix,
            resident.date_of_birth AS resident_date_of_birth,
            resident.contact_number AS resident_contact_number,
            resident.house_no_street AS resident_house_no_street,
            resident.purok AS resident_purok,
            resident.barangay AS resident_barangay,
            resident.city_municipality AS resident_city_municipality,
            resident.province AS resident_province,
            account.email AS resident_email
        FROM registration_requests
        LEFT JOIN registration_reference_access AS reference_access
            ON reference_access.registration_id = registration_requests.id
        LEFT JOIN residents AS resident
            ON resident.resident_code = COALESCE(reference_access.resident_code, (
                SELECT fallback_resident.resident_code
                FROM residents AS fallback_resident
                INNER JOIN users AS fallback_account ON fallback_account.id = fallback_resident.user_id
                WHERE LOWER(fallback_account.email) = LOWER(registration_requests.email)
                  AND fallback_account.role = 'resident'
                ORDER BY fallback_resident.id DESC
                LIMIT 1
            ))
        LEFT JOIN users AS account
            ON account.id = resident.user_id
        WHERE registration_requests.status IN ('approved', 'rejected', 'declined')
        ORDER BY registration_requests.created_at DESC, registration_requests.id DESC
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
