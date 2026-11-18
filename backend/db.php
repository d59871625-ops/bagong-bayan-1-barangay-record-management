<?php

require_once __DIR__ . "/config.php";
try {
    loadBackendEnvironment(__DIR__ . "/.env");
} catch (RuntimeException $error) {
    error_log("Backend environment configuration error: " . $error->getMessage());
    header("Content-Type: application/json; charset=UTF-8");
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Backend environment configuration is invalid."
    ]);
    exit;
}

$configuredOrigins = getenv("BRGY_ALLOWED_ORIGINS");
$allowedOrigins = $configuredOrigins === false
    ? [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174"
    ]
    : array_filter(array_map("trim", explode(",", $configuredOrigins)));

$origin = $_SERVER["HTTP_ORIGIN"] ?? "";

if (in_array($origin, $allowedOrigins, true)) {
    header("Access-Control-Allow-Origin: " . $origin);
    header("Vary: Origin");
}

header("Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Access-Control-Max-Age: 600");
header("Content-Type: application/json; charset=UTF-8");

if (($_SERVER["REQUEST_METHOD"] ?? "") === "OPTIONS") {
    http_response_code(204);
    exit;
}

$host = getenv("BRGY_DB_HOST") ?: "127.0.0.1";
$dbname = getenv("BRGY_DB_NAME") ?: "vite_brygmanagmentsystem";
$username = getenv("BRGY_DB_USER") ?: "root";
$password = getenv("BRGY_DB_PASSWORD");
if ($password === false) {
    $password = "";
}

try {
    $pdo = new PDO(
        "mysql:host=$host;dbname=$dbname;charset=utf8mb4",
        $username,
        $password,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false
        ]
    );
} catch (PDOException $e) {
    error_log("Database connection failed: " . $e->getMessage());
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Database connection failed."
    ]);
    exit;
}
