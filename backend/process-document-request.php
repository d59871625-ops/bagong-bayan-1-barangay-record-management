<?php
require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

header("Content-Type: application/json; charset=utf-8");

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    http_response_code(405);
    echo json_encode([
        "success" => false,
        "message" => "Method not allowed. Use POST."
    ]);
    exit;
}

$user = authenticateUser($pdo, ["admin", "official"]);

$data = json_decode(file_get_contents("php://input"), true);

if (!is_array($data)) {
    http_response_code(400);
    echo json_encode([
        "success" => false,
        "message" => "Invalid JSON request."
    ]);
    exit;
}

$requestId = filter_var(
    $data["request_id"] ?? null,
    FILTER_VALIDATE_INT
);

$status = trim($data["status"] ?? "");
$remarks = trim($data["remarks"] ?? "");

$allowedStatuses = [
    "pending",
    "processing",
    "approved",
    "rejected",
    "ready",
    "completed"
];

if (!$requestId || $requestId < 1) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "A valid request ID is required."
    ]);
    exit;
}

if (!in_array($status, $allowedStatuses, true)) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "Invalid document request status."
    ]);
    exit;
}

if (mb_strlen($remarks) > 5000) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "Remarks must not exceed 5000 characters."
    ]);
    exit;
}

try {
    $checkStmt = $pdo->prepare("
        SELECT id
        FROM document_requests
        WHERE id = ?
        LIMIT 1
    ");
    $checkStmt->execute([$requestId]);

    if (!$checkStmt->fetch(PDO::FETCH_ASSOC)) {
        http_response_code(404);
        echo json_encode([
            "success" => false,
            "message" => "Document request not found."
        ]);
        exit;
    }

    $updateStmt = $pdo->prepare("
        UPDATE document_requests
        SET
            status = ?,
            processed_by = ?,
            remarks = ?
        WHERE id = ?
    ");

    $updateStmt->execute([
        $status,
        $user["id"],
        $remarks !== "" ? $remarks : null,
        $requestId
    ]);

    echo json_encode([
        "success" => true,
        "message" => "Document request updated successfully.",
        "data" => [
            "request_id" => $requestId,
            "status" => $status,
            "processed_by" => (int) $user["id"],
            "remarks" => $remarks !== "" ? $remarks : null
        ]
    ]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Failed to update document request."
    ]);
}
