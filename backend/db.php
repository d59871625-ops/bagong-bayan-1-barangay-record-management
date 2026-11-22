<?php

require_once __DIR__ . "/config.php";
$environmentFile = __DIR__ . "/.env";
try {
    $backendEnvironment = loadBackendEnvironment($environmentFile);
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
$environmentValue = static function (string $name) use ($backendEnvironment): ?string {
    return backendEnvironmentValue($backendEnvironment, $name);
};

$configuredOrigins = backendEnv("BRGY_ALLOWED_ORIGINS");
$allowedOrigins = $configuredOrigins === null
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
header("Access-Control-Allow-Headers: Content-Type, Authorization, If-None-Match, X-Public-Data-Match");
header("Access-Control-Expose-Headers: ETag, X-Public-Data-ETag");
header("Access-Control-Max-Age: 600");
header("Content-Type: application/json; charset=UTF-8");

if (($_SERVER["REQUEST_METHOD"] ?? "") === "OPTIONS") {
    http_response_code(204);
    exit;
}

$configuredHost = backendEnv("BRGY_DB_HOST");
$configuredDatabase = backendEnv("BRGY_DB_NAME");
$configuredUsername = backendEnv("BRGY_DB_USER");
$requestHost = strtolower($_SERVER["HTTP_HOST"] ?? "");
$isLocalRequest = preg_match('/^(localhost|127\.0\.0\.1)(:\d+)?$/', $requestHost) === 1
    || in_array($requestHost, ["::1", "[::1]"], true);
$host = $configuredHost ?: ($isLocalRequest ? "127.0.0.1" : "sql102.infinityfree.com");
$dbname = $configuredDatabase ?: ($isLocalRequest ? "vite_brygmanagmentsystem" : "if0_43466477_barangay_management_system");
$username = $configuredUsername ?: ($isLocalRequest ? "root" : "if0_43466477");
$password = backendEnv("BRGY_DB_PASSWORD");
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
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_TIMEOUT => 30
        ]
    );
} catch (PDOException $e) {
    error_log("Database connection failed: " . $e->getMessage());
    $driverCode = $e->errorInfo[1] ?? "unknown";
    $driverMessage = preg_replace('/[\r\n]+/', ' ', (string) ($e->errorInfo[2] ?? "unknown"));
    $configuredVariables = array_filter([
        $configuredHost ? "host" : "",
        $configuredDatabase ? "database" : "",
        $configuredUsername ? "username" : "",
         backendEnv("BRGY_DB_PASSWORD") ? "password" : ""
    ]);
    $diagnostic = sprintf(
        "time=%s sqlstate=%s driver_code=%s host=%s database=%s username=%s password_set=%s env_file=%s configured=%s message=%s",
        gmdate("c"),
        (string) $e->getCode(),
        (string) $driverCode,
        $host,
        $dbname,
        $username,
        $password === "" ? "no" : "yes",
        is_file($environmentFile) ? "yes" : "no",
        implode(",", $configuredVariables) ?: "none",
        substr($driverMessage, 0, 200)
    );
    if (file_put_contents(__DIR__ . "/database-connection-status.log", $diagnostic . PHP_EOL, LOCK_EX) === false) {
        error_log("Unable to write database connection status file.");
    }
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Database connection failed."
    ]);
    exit;
}
