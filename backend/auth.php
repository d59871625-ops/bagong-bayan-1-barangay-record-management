<?php

header("Content-Type: application/json; charset=UTF-8");

function authenticateUser(PDO $pdo, array $allowedRoles = ["admin", "official"]): array
{
    $headers = function_exists("getallheaders") ? getallheaders() : [];

    $authorization = $headers["Authorization"]
        ?? $headers["authorization"]
        ?? $_SERVER["HTTP_AUTHORIZATION"]
        ?? "";

    if (!preg_match('/^Bearer\s+([a-f0-9]{64})$/i', trim($authorization), $matches)) {
        http_response_code(401);
        echo json_encode([
            "success" => false,
            "message" => "Authentication token is required."
        ]);
        exit;
    }

    $tokenHash = hash("sha256", $matches[1]);

    try {
        $stmt = $pdo->prepare("
            SELECT
                users.id,
                users.full_name,
                users.email,
                users.role,
                users.account_status
            FROM api_tokens
            INNER JOIN users ON users.id = api_tokens.user_id
            WHERE api_tokens.token_hash = ?
              AND api_tokens.revoked_at IS NULL
              AND (api_tokens.expires_at IS NULL OR api_tokens.expires_at > NOW())
              AND users.account_status = 'active'
            LIMIT 1
        ");

        $stmt->execute([$tokenHash]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$user) {
            http_response_code(401);
            echo json_encode([
                "success" => false,
                "message" => "Invalid or expired authentication token."
            ]);
            exit;
        }

        if (!in_array($user["role"], $allowedRoles, true)) {
            http_response_code(403);
            echo json_encode([
                "success" => false,
                "message" => "You are not authorized to access this resource."
            ]);
            exit;
        }

        $user["id"] = (int) $user["id"];

        return $user;

    } catch (Throwable $e) {
        error_log("Authentication error: " . $e->getMessage());

        http_response_code(500);
        echo json_encode([
            "success" => false,
            "message" => "Authentication service error."
        ]);
        exit;
    }
}