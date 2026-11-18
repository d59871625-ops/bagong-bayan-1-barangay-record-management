<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

require_once __DIR__ . "/db.php";

function respond(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data);
    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    header("Allow: POST");
    respond(405, [
        "success" => false,
        "message" => "Method not allowed."
    ]);
}

$input = json_decode(file_get_contents("php://input"), true);

if (!is_array($input)) {
    respond(400, [
        "success" => false,
        "message" => "Invalid JSON request."
    ]);
}

$email = strtolower(trim($input["email"] ?? ""));
$password = $input["password"] ?? "";

if (!filter_var($email, FILTER_VALIDATE_EMAIL) || !is_string($password) || $password === "") {
    respond(422, [
        "success" => false,
        "message" => "Valid email and password are required."
    ]);
}

try {
    $stmt = $pdo->prepare("
        SELECT id, full_name, email, password_hash, role, account_status
        FROM users
        WHERE email = ?
        LIMIT 1
    ");

    $stmt->execute([$email]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$user) {
        respond(401, [
            "success" => false,
            "message" => "Invalid email or password."
        ]);
    }

    $storedPassword = $user["password_hash"];
    $passwordIsValid = password_verify($password, $storedPassword);

    if (
        !$passwordIsValid
        && password_get_info($storedPassword)["algoName"] === "unknown"
        && hash_equals($storedPassword, $password)
    ) {
        $upgradedPassword = password_hash($password, PASSWORD_DEFAULT);
        if ($upgradedPassword === false) {
            throw new RuntimeException("Unable to upgrade the legacy password hash.");
        }

        $upgrade = $pdo->prepare("
            UPDATE users
            SET password_hash = ?
            WHERE id = ?
              AND password_hash = ?
        ");
        $upgrade->execute([$upgradedPassword, $user["id"], $storedPassword]);
        $passwordIsValid = $upgrade->rowCount() === 1;

        if (!$passwordIsValid) {
            $refreshPassword = $pdo->prepare("SELECT password_hash FROM users WHERE id = ? LIMIT 1");
            $refreshPassword->execute([$user["id"]]);
            $latestPassword = $refreshPassword->fetchColumn();
            $passwordIsValid = is_string($latestPassword) && password_verify($password, $latestPassword);
        }
    }

    if (!$passwordIsValid) {
        respond(401, [
            "success" => false,
            "message" => "Invalid email or password."
        ]);
    }

    if ($user["account_status"] !== "active") {
        respond(403, [
            "success" => false,
            "message" => "Your account is not active."
        ]);
    }

    $token = bin2hex(random_bytes(32));
    $tokenHash = hash("sha256", $token);

    $saveToken = $pdo->prepare("
        INSERT INTO api_tokens (user_id, token_hash, expires_at)
        VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))
    ");

    $saveToken->execute([$user["id"], $tokenHash]);

    respond(200, [
        "success" => true,
        "message" => "Login successful.",
        "token" => $token,
        "data" => [
            "id" => (int) $user["id"],
            "full_name" => $user["full_name"],
            "email" => $user["email"],
            "role" => $user["role"],
            "account_status" => $user["account_status"]
        ]
    ]);

} catch (Throwable $e) {
    error_log("Login API error: " . $e->getMessage());

    respond(500, [
        "success" => false,
        "message" => "An internal server error occurred."
    ]);
}