<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

function respondAdminMailSettings(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER["REQUEST_METHOD"] ?? "") !== "GET") {
    header("Allow: GET, OPTIONS");
    respondAdminMailSettings(405, ["success" => false, "message" => "Method not allowed."]);
}

try {
    authenticateUser($pdo, ["admin", "official"]);
    $emailAddress = trim((string) backendEnv("BRGY_GMAIL_USERNAME"));
    if (!filter_var($emailAddress, FILTER_VALIDATE_EMAIL)) {
        respondAdminMailSettings(503, ["success" => false, "message" => "The backend Gmail account is not configured."]);
    }

    respondAdminMailSettings(200, [
        "success" => true,
        "data" => [
            "emailAddress" => $emailAddress,
            "senderName" => trim((string) backendEnv("BRGY_GMAIL_FROM_NAME")) ?: "Barangay Bagong Bayan I",
        ],
    ]);
} catch (Throwable $error) {
    error_log("Admin mail settings could not be loaded.");
    respondAdminMailSettings(500, ["success" => false, "message" => "The configured Gmail account could not be loaded."]);
}
