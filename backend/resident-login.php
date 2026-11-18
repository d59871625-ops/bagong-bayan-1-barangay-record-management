<?php

require_once __DIR__ . "/db.php";

header("Content-Type: application/json");

function respond(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data, JSON_PRETTY_PRINT);
    exit;
}

function residentNameTokens(string $value): array
{
    $tokens = preg_split('/\s+/', strtolower(trim($value))) ?: [];
    return array_values(array_filter(array_map(
        fn($token) => preg_replace('/[^a-z0-9]/', '', $token),
        $tokens
    )));
}

function findTokenSequence(array $tokens, array $sequence, int $start, ?int $end = null): int
{
    $end ??= count($tokens);
    for ($index = $start; $index <= $end - count($sequence); $index++) {
        if (array_slice($tokens, $index, count($sequence)) === $sequence) {
            return $index;
        }
    }

    return -1;
}

function residentNameMatches(array $resident, array $input): bool
{
    $registeredTokens = residentNameTokens(implode(" ", array_filter(
        [
            $resident["first_name"],
            $resident["middle_name"],
            $resident["last_name"],
            $resident["suffix"]
        ],
        fn($part) => $part !== null && trim((string) $part) !== ""
    )));
    $firstTokens = residentNameTokens($input["first_name"]);
    $middleTokens = residentNameTokens($input["middle_name"]);
    $lastTokens = residentNameTokens($input["last_name"]);
    $suffixTokens = residentNameTokens($input["suffix"]);

    if (!$firstTokens || !$lastTokens || array_slice($registeredTokens, 0, count($firstTokens)) !== $firstTokens) {
        return false;
    }

    $firstEnd = count($firstTokens);
    $lastStart = findTokenSequence($registeredTokens, $lastTokens, $firstEnd);

    if ($lastStart < 0) {
        return false;
    }

    if ($middleTokens && findTokenSequence($registeredTokens, $middleTokens, $firstEnd, $lastStart) < 0) {
        return false;
    }

    return !$suffixTokens
        || findTokenSequence($registeredTokens, $suffixTokens, $lastStart + count($lastTokens)) >= 0;
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
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

$residentCodeValue = $input["resident_code"] ?? "";
if (!is_string($residentCodeValue)) {
    respond(422, [
        "success" => false,
        "message" => "Resident details are invalid."
    ]);
}

$residentCode = strtoupper(trim($residentCodeValue));
$nameInput = [
    "first_name" => "",
    "middle_name" => "",
    "last_name" => "",
    "suffix" => ""
];
foreach (array_keys($nameInput) as $field) {
    $value = $input[$field] ?? "";
    if (!is_string($value)) {
        respond(422, [
            "success" => false,
            "message" => "Resident details are invalid."
        ]);
    }
    $nameInput[$field] = trim($value);
}

if ($residentCode === "" || $nameInput["first_name"] === "" || $nameInput["last_name"] === "") {
    respond(422, [
        "success" => false,
        "message" => "First name, last name, and resident code are required."
    ]);
}

try {
    $stmt = $pdo->prepare("
        SELECT
            u.id,
            u.full_name,
            u.email,
            u.role,
            u.account_status,
            r.id AS resident_id,
            r.resident_code,
            r.first_name,
            r.middle_name,
            r.last_name,
            r.suffix
        FROM residents r
        INNER JOIN users u ON u.id = r.user_id
        WHERE r.resident_code = ?
          AND r.record_status = 'active'
          AND u.role = 'resident'
          AND u.account_status = 'active'
        LIMIT 1
    ");

    $stmt->execute([$residentCode]);
    $resident = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$resident || !residentNameMatches($resident, $nameInput)) {
        respond(401, [
            "success" => false,
            "message" => "Invalid resident details or inactive account."
        ]);
    }

    $token = bin2hex(random_bytes(32));
    $tokenHash = hash("sha256", $token);

    $expiresAt = date(
        "Y-m-d H:i:s",
        time() + (30 * 24 * 60 * 60)
    );

    $stmt = $pdo->prepare("
        INSERT INTO api_tokens
            (user_id, token_hash, created_at, expires_at)
        VALUES (?, ?, NOW(), ?)
    ");

    $stmt->execute([
        $resident["id"],
        $tokenHash,
        $expiresAt
    ]);

    respond(200, [
        "success" => true,
        "message" => "Resident login successful.",
        "token" => $token,
        "data" => [
            "id" => (int) $resident["id"],
            "resident_id" => (int) $resident["resident_id"],
            "full_name" => $resident["full_name"],
            "resident_code" => $resident["resident_code"],
            "role" => $resident["role"],
            "account_status" => $resident["account_status"]
        ]
    ]);

} catch (Throwable $e) {
    error_log("Resident login error: " . $e->getMessage());

    respond(500, [
        "success" => false,
        "message" => "An internal server error occurred."
    ]);
}