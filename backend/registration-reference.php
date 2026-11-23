<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
header("Pragma: no-cache");
header("Expires: 0");

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/registration-application-storage.php";

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function referenceNameTokens(string $value): array
{
    $value = function_exists("mb_strtolower") ? mb_strtolower($value, "UTF-8") : strtolower($value);
    $tokens = preg_split('/\s+/u', trim($value), -1, PREG_SPLIT_NO_EMPTY) ?: [];
    return array_values(array_filter(array_map(static fn($token) => preg_replace('/[^a-z0-9]/', '', $token) ?? "", $tokens)));
}

function referenceNameMatches(array $application, array $input): bool
{
    $registered = referenceNameTokens(implode(" ", array_filter([
        $application["first_name"] ?? "",
        $application["middle_name"] ?? "",
        $application["last_name"] ?? "",
        $application["suffix"] ?? ""
    ], static fn($part) => trim((string) $part) !== "")));
    $first = referenceNameTokens($input["first_name"]);
    $middle = referenceNameTokens($input["middle_name"]);
    $last = referenceNameTokens($input["last_name"]);
    $suffix = referenceNameTokens($input["suffix"]);
    $findSequence = static function (array $tokens, array $sequence, int $start, ?int $end = null): int {
        $end ??= count($tokens);
        for ($index = $start; $index <= $end - count($sequence); $index++) {
            if (array_slice($tokens, $index, count($sequence)) === $sequence) return $index;
        }
        return -1;
    };
    if (!$first || !$last || array_slice($registered, 0, count($first)) !== $first) return false;
    $lastStart = $findSequence($registered, $last, count($first));
    if ($lastStart < 0) return false;
    if ($middle && $findSequence($registered, $middle, count($first), $lastStart) < 0) return false;
    return !$suffix || $findSequence($registered, $suffix, $lastStart + count($last)) >= 0;
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    header("Allow: POST");
    respond(405, ["success" => false, "message" => "Method not allowed."]);
}

$input = json_decode(file_get_contents("php://input"), true);
if (!is_array($input)) respond(400, ["success" => false, "message" => "Invalid JSON request."]);
$action = $input["action"] ?? "lookup";
$reference = strtoupper(trim((string) ($input["reference"] ?? "")));
$name = $input["name"] ?? null;
if (!in_array($action, ["lookup", "acknowledge"], true)
    || !preg_match('/^(?:DB-)?REG-(?:[1-9][0-9]*|[0-9]{4}-[A-F0-9]{16})$/', $reference)
    || !is_array($name)) {
    respond(422, ["success" => false, "message" => "A valid application reference and applicant name are required."]);
}
$nameInput = [];
foreach (["first_name", "middle_name", "last_name", "suffix"] as $field) {
    $value = $name[$field] ?? "";
    if (!is_string($value) || strlen($value) > 120) respond(422, ["success" => false, "message" => "Applicant details are invalid."]);
    $nameInput[$field] = trim($value);
}
if ($nameInput["first_name"] === "" || $nameInput["last_name"] === "") {
    respond(422, ["success" => false, "message" => "First and last name are required."]);
}

try {
    ensureRegistrationReferenceAccessTable($pdo);
    if (preg_match('/^(?:DB-)?REG-([1-9][0-9]*)$/', $reference, $matches)) {
        $registrationId = (int) $matches[1];
        $stmt = $pdo->prepare("SELECT r.id, r.first_name, r.middle_name, r.last_name, r.suffix,
                r.status, r.reviewed_at, r.rejection_reason, a.resident_code,
                a.declined_notice_acknowledged_at
            FROM registration_requests AS r
            LEFT JOIN registration_reference_access AS a ON a.registration_id = r.id
            WHERE r.id = ? LIMIT 1");
        $stmt->execute([$registrationId]);
        $application = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$application || !referenceNameMatches($application, $nameInput)) {
            respond(404, ["success" => false, "message" => "Application reference or applicant name was not found."]);
        }
        $status = strtolower((string) $application["status"]);
        $code = $application["resident_code"] ?: null;
        if ($status === "approved" && !$code) {
            $fallback = $pdo->prepare("SELECT residents.resident_code FROM residents
                INNER JOIN users ON users.id = residents.user_id
                INNER JOIN registration_requests ON LOWER(users.email) = LOWER(registration_requests.email)
                WHERE registration_requests.id = ? AND residents.record_status = 'active'
                ORDER BY residents.id DESC LIMIT 1");
            $fallback->execute([$registrationId]);
            $code = $fallback->fetchColumn() ?: null;
            if ($code) {
                $saveCode = $pdo->prepare("INSERT INTO registration_reference_access (registration_id, resident_code)
                    VALUES (?, ?) ON DUPLICATE KEY UPDATE resident_code = COALESCE(resident_code, VALUES(resident_code))");
                $saveCode->execute([$registrationId, $code]);
            }
        }
        if ($action === "acknowledge") {
            if (!in_array($status, ["rejected", "declined"], true)) respond(409, ["success" => false, "message" => "There is no declined application notice to acknowledge."]);
            $ack = $pdo->prepare("UPDATE registration_reference_access
                SET declined_notice_acknowledged_at = COALESCE(declined_notice_acknowledged_at, NOW())
                WHERE registration_id = ?");
            $ack->execute([$registrationId]);
            respond(200, ["success" => true, "data" => ["acknowledged" => true]]);
        }
        if (in_array($status, ["rejected", "declined"], true) && $application["declined_notice_acknowledged_at"]) {
            respond(200, ["success" => true, "data" => ["status" => "used"]]);
        }
        if ($status === "approved" && !$code) {
            respond(503, ["success" => false, "message" => "The approved resident code is not available yet. Please contact the barangay office."]);
        }
        respond(200, ["success" => true, "data" => [
            "reference" => "DB-REG-" . $registrationId,
            "status" => in_array($status, ["rejected", "declined"], true) ? "Declined" : ($status === "approved" ? "Approved" : "Pending"),
            "resident_code" => $status === "approved" ? $code : null,
            "rejection_reason" => $application["rejection_reason"] ?? "",
        ]]);
    }
    respond(404, ["success" => false, "message" => "Application reference or applicant name was not found."]);
} catch (Throwable $error) {
    error_log("Registration reference service error: " . $error->getMessage());
    respond(500, ["success" => false, "message" => "Unable to verify this application right now."]);
}
