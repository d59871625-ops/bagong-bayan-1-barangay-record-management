<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

function respondPasswordChange(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER["REQUEST_METHOD"] ?? "") !== "POST") {
    header("Allow: POST, OPTIONS");
    respondPasswordChange(405, ["success" => false, "message" => "Method not allowed."]);
}

try {
    $user = authenticateUser($pdo, ["admin", "official"]);
    $input = json_decode(file_get_contents("php://input"), true, 512, JSON_THROW_ON_ERROR);
    $currentPassword = $input["currentPassword"] ?? null;
    $newPassword = $input["newPassword"] ?? null;
    if (!is_string($currentPassword) || $currentPassword === "" || !is_string($newPassword)) {
        respondPasswordChange(422, ["success" => false, "message" => "Enter your current password and a new password."]);
    }
    if (strlen($newPassword) < 12) {
        respondPasswordChange(422, ["success" => false, "message" => "Use a new password with at least 12 characters."]);
    }
    if (hash_equals($currentPassword, $newPassword)) {
        respondPasswordChange(422, ["success" => false, "message" => "Choose a password different from your current one."]);
    }

    $find = $pdo->prepare("SELECT password_hash FROM users WHERE id = ? AND account_status = 'active' LIMIT 1");
    $find->execute([(int) $user["id"]]);
    $storedPassword = $find->fetchColumn();
    $currentPasswordIsValid = is_string($storedPassword) && password_verify($currentPassword, $storedPassword);
    if (is_string($storedPassword)
        && !$currentPasswordIsValid
        && password_get_info($storedPassword)["algoName"] === "unknown") {
        $currentPasswordIsValid = hash_equals($storedPassword, $currentPassword);
    }
    if (!$currentPasswordIsValid) {
        respondPasswordChange(401, ["success" => false, "message" => "The current password is incorrect."]);
    }

    $newPasswordHash = password_hash($newPassword, PASSWORD_DEFAULT);
    if ($newPasswordHash === false) {
        throw new RuntimeException("Unable to secure the new password.");
    }
    $update = $pdo->prepare("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ? AND account_status = 'active'");
    $update->execute([$newPasswordHash, (int) $user["id"], $storedPassword]);
    if ($update->rowCount() !== 1) {
        respondPasswordChange(409, ["success" => false, "message" => "The password changed in another session. Sign in again and retry."]);
    }

    $headers = function_exists("getallheaders") ? getallheaders() : [];
    $authorization = $headers["Authorization"] ?? $headers["authorization"] ?? $_SERVER["HTTP_AUTHORIZATION"] ?? "";
    if (preg_match('/^Bearer\s+([a-f0-9]{64})$/i', trim((string) $authorization), $matches)) {
        $revokeOtherSessions = $pdo->prepare("UPDATE api_tokens SET revoked_at = NOW() WHERE user_id = ? AND token_hash <> ? AND revoked_at IS NULL");
        $revokeOtherSessions->execute([(int) $user["id"], hash("sha256", $matches[1])]);
    }

    respondPasswordChange(200, ["success" => true, "message" => "Admin account password updated successfully."]);
} catch (JsonException $error) {
    respondPasswordChange(400, ["success" => false, "message" => "Invalid JSON request."]);
} catch (Throwable $error) {
    error_log("Admin password change failed: " . $error->getMessage());
    respondPasswordChange(500, ["success" => false, "message" => "The admin password could not be changed."]);
}
