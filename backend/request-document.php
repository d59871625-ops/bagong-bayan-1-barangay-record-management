<?php
require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

header("Content-Type: application/json");

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    http_response_code(405);
    echo json_encode([
        "success" => false,
        "message" => "Method not allowed. Use POST."
    ]);
    exit;
}

$user = authenticateUser($pdo, ["resident"]);

$data = json_decode(file_get_contents("php://input"), true);

if (!is_array($data)) {
    http_response_code(400);
    echo json_encode([
        "success" => false,
        "message" => "Invalid JSON request."
    ]);
    exit;
}

$documentType = trim($data["document_type"] ?? "");
$purpose = trim($data["purpose"] ?? "");

$allowedTypes = [
    "Barangay Clearance",
    "Certificate of Residency",
    "Certificate of Indigency",
    "Barangay Business Clearance"
];

if (!in_array($documentType, $allowedTypes, true)) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "Invalid document type."
    ]);
    exit;
}

if ($purpose === "" || mb_strlen($purpose) > 1000) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "Purpose is required and must not exceed 1000 characters."
    ]);
    exit;
}

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
        INSERT INTO document_requests
            (resident_id, document_type, purpose, status)
        VALUES
            (?, ?, ?, 'pending')
    ");

    $stmt->execute([
        $resident["id"],
        $documentType,
        $purpose
    ]);

    http_response_code(201);
    echo json_encode([
        "success" => true,
        "message" => "Document request submitted successfully.",
        "data" => [
            "id" => (int) $pdo->lastInsertId(),
            "document_type" => $documentType,
            "purpose" => $purpose,
            "status" => "pending"
        ]
    ]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Failed to submit document request."
    ]);
}
