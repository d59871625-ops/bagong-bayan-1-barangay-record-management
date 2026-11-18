<?php

require_once __DIR__ . "/vendor/autoload.php";
require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

use PHPMailer\PHPMailer\PHPMailer;

header("Cache-Control: no-store");
header("Referrer-Policy: no-referrer");
header("X-Content-Type-Options: nosniff");

class AdminInvitationException extends RuntimeException
{
    public int $httpStatus;

    public function __construct(string $message, int $httpStatus)
    {
        parent::__construct($message);
        $this->httpStatus = $httpStatus;
    }
}

function respondAdminInvitationJson(int $status, array $data): void
{
    header("Content-Type: application/json; charset=UTF-8");
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function escapeAdminInvitationHtml(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, "UTF-8");
}

function respondAdminInvitationPage(string $title, string $content, int $status = 200): void
{
    header("Content-Type: text/html; charset=UTF-8");
    header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    http_response_code($status);
    $safeTitle = escapeAdminInvitationHtml($title);
    echo "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>{$safeTitle}</title><style>
        *{box-sizing:border-box}body{margin:0;padding:24px;background:#f3f7f3;color:#263329;font:16px Arial,sans-serif}
        main{max-width:520px;margin:8vh auto;padding:28px;border:1px solid #d5e5d7;border-radius:14px;background:#fff;box-shadow:0 12px 36px #19311a12}
        h1{margin:0 0 12px;color:#294d31;font-size:24px}p{line-height:1.55;color:#526357}
        label{display:grid;gap:6px;margin:14px 0;color:#355d3b;font-size:13px;font-weight:700}
        input{width:100%;padding:11px;border:1px solid #c4d9c7;border-radius:8px;font:inherit}
        .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
        button,.button{display:inline-block;padding:11px 16px;border:1px solid #34703d;border-radius:8px;background:#34703d;color:#fff;text-decoration:none;font:700 14px Arial,sans-serif;cursor:pointer}
        .secondary{border-color:#d5e2d6;background:#fff;color:#435348}
        .error{color:#9e332b}.email{overflow-wrap:anywhere;font-weight:700;color:#344239}
        </style></head><body><main><h1>{$safeTitle}</h1>{$content}</main></body></html>";
    exit;
}

function ensureAdminInvitationTable(PDO $pdo): void
{
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS admin_invitations (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            invited_email VARCHAR(254) NOT NULL,
            token_hash CHAR(64) NOT NULL UNIQUE,
            inviter_user_id BIGINT UNSIGNED NOT NULL,
            status ENUM('pending', 'accepted', 'declined', 'expired') NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP NOT NULL,
            responded_at TIMESTAMP NULL DEFAULT NULL,
            INDEX idx_admin_invitation_email_status (invited_email, status),
            INDEX idx_admin_invitation_inviter_created (inviter_user_id, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");
}

function sendAdminInvitationEmail(string $recipient, string $invitationUrl): void
{
    $username = trim((string) getenv("BRGY_GMAIL_USERNAME"));
    $appPassword = preg_replace('/\s+/', '', (string) getenv("BRGY_GMAIL_APP_PASSWORD"));
    $senderName = trim((string) getenv("BRGY_GMAIL_FROM_NAME")) ?: "Barangay Bagong Bayan I";
    if ($username === "" || $appPassword === "") {
        throw new AdminInvitationException("Email delivery is not configured on the backend.", 503);
    }

    try {
        $mail = new PHPMailer(true);
        $mail->isSMTP();
        $mail->Host = "smtp.gmail.com";
        $mail->SMTPAuth = true;
        $mail->Username = $username;
        $mail->Password = $appPassword;
        $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
        $mail->Port = 587;
        $mail->CharSet = "UTF-8";
        $mail->setFrom($username, $senderName);
        $mail->addAddress($recipient);
        $mail->Subject = "Invitation to become a Barangay Bagong Bayan I system administrator";
        $safeUrl = escapeAdminInvitationHtml($invitationUrl);
        $mail->isHTML(true);
        $mail->Body = "<p>You have been invited to become an administrator of the Barangay Bagong Bayan I system.</p>"
            . "<p>Choose whether to accept or decline. This invitation expires in seven days.</p>"
            . "<p><a href=\"{$safeUrl}&amp;action=accept\">Accept invitation</a></p>"
            . "<p><a href=\"{$safeUrl}&amp;action=decline\">Decline invitation</a></p>"
            . "<p>If you were not expecting this invitation, you can ignore this email.</p>";
        $mail->AltBody = "You have been invited to become an administrator of the Barangay Bagong Bayan I system.\n\n"
            . "Accept: {$invitationUrl}&action=accept\n"
            . "Decline: {$invitationUrl}&action=decline\n\n"
            . "This invitation expires in seven days. If you were not expecting it, ignore this email.";
        $mail->send();
    } catch (AdminInvitationException $error) {
        throw $error;
    } catch (Throwable $error) {
        error_log("Admin invitation email delivery failed.");
        throw new AdminInvitationException("The invitation email could not be sent. Check the Gmail SMTP configuration and try again.", 502);
    }
}

function renderAdminInvitationTokenPage(PDO $pdo, string $token, string $action): void
{
    if (!preg_match('/^[a-f0-9]{64}$/i', $token)) {
        respondAdminInvitationPage("Invitation unavailable", "<p class=\"error\">This invitation link is invalid or incomplete.</p>", 400);
    }

    $tokenHash = hash("sha256", $token);
    $statement = $pdo->prepare("
        SELECT id, invited_email, status, expires_at, (expires_at > NOW()) AS is_unexpired
        FROM admin_invitations
        WHERE token_hash = ?
        LIMIT 1
    ");
    $statement->execute([$tokenHash]);
    $invitation = $statement->fetch(PDO::FETCH_ASSOC);
    if (!$invitation || $invitation["status"] !== "pending" || !(bool) $invitation["is_unexpired"]) {
        respondAdminInvitationPage(
            "Invitation unavailable",
            "<p class=\"error\">This invitation is invalid, expired, or has already been answered.</p><p>If you still need access, ask an administrator to send a new invitation.</p>",
            410
        );
    }

    $email = escapeAdminInvitationHtml($invitation["invited_email"]);
    $safeToken = escapeAdminInvitationHtml($token);
    if ($action === "decline") {
        $content = "<p>You may decline the administrator invitation for <span class=\"email\">{$email}</span>.</p>"
            . "<form method=\"post\"><input type=\"hidden\" name=\"token\" value=\"{$safeToken}\">"
            . "<div class=\"actions\"><button type=\"submit\" name=\"action\" value=\"decline\">Decline invitation</button>"
            . "<a class=\"button secondary\" href=\"?token={$safeToken}\">Go back</a></div></form>";
        respondAdminInvitationPage("Decline administrator invitation", $content);
    }

    if ($action === "accept") {
        $userStatement = $pdo->prepare("SELECT id, account_status FROM users WHERE email = ? LIMIT 1");
        $userStatement->execute([$invitation["invited_email"]]);
        $existingUser = $userStatement->fetch(PDO::FETCH_ASSOC);
        if ($existingUser && $existingUser["account_status"] !== "active") {
            respondAdminInvitationPage(
                "Administrator invitation",
                "<p class=\"error\">An inactive account already uses this email. Contact the barangay office before accepting the invitation.</p>",
                409
            );
        }

        $content = "<p>Accepting this invitation grants administrator access to <span class=\"email\">{$email}</span>.</p>";
        if ($existingUser) {
            $content .= "<p>Your existing account and password will remain unchanged.</p>"
                . "<form method=\"post\"><input type=\"hidden\" name=\"token\" value=\"{$safeToken}\">"
                . "<div class=\"actions\"><button type=\"submit\" name=\"action\" value=\"accept\">Accept and become an administrator</button>"
                . "<a class=\"button secondary\" href=\"?token={$safeToken}\">Go back</a></div></form>";
        } else {
            $content .= "<p>Create the password you will use to sign in.</p>"
                . "<form method=\"post\"><input type=\"hidden\" name=\"token\" value=\"{$safeToken}\">"
                . "<label>Full name<input name=\"full_name\" autocomplete=\"name\" minlength=\"2\" maxlength=\"120\" required></label>"
                . "<label>Password (at least 12 characters)<input name=\"password\" type=\"password\" autocomplete=\"new-password\" minlength=\"12\" required></label>"
                . "<label>Confirm password<input name=\"password_confirmation\" type=\"password\" autocomplete=\"new-password\" minlength=\"12\" required></label>"
                . "<div class=\"actions\"><button type=\"submit\" name=\"action\" value=\"accept\">Accept and create admin account</button>"
                . "<a class=\"button secondary\" href=\"?token={$safeToken}\">Go back</a></div></form>";
        }
        respondAdminInvitationPage("Accept administrator invitation", $content);
    }

    $content = "<p><span class=\"email\">{$email}</span> has been invited to become an administrator.</p>"
        . "<p>This single-use invitation expires in seven days.</p>"
        . "<div class=\"actions\"><a class=\"button\" href=\"?token={$safeToken}&amp;action=accept\">Review and accept</a>"
        . "<a class=\"button secondary\" href=\"?token={$safeToken}&amp;action=decline\">Decline invitation</a></div>";
    respondAdminInvitationPage("Administrator invitation", $content);
}

function handleAdminInvitationDecision(PDO $pdo, string $action, string $token): void
{
    if (!in_array($action, ["accept", "decline"], true) || !preg_match('/^[a-f0-9]{64}$/i', $token)) {
        respondAdminInvitationPage("Invitation unavailable", "<p class=\"error\">The invitation action or link is invalid.</p>", 400);
    }

    try {
        $pdo->beginTransaction();
        $statement = $pdo->prepare("
            SELECT id, invited_email, status, (expires_at > NOW()) AS is_unexpired
            FROM admin_invitations
            WHERE token_hash = ?
            LIMIT 1
            FOR UPDATE
        ");
        $statement->execute([hash("sha256", $token)]);
        $invitation = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$invitation || $invitation["status"] !== "pending" || !(bool) $invitation["is_unexpired"]) {
            $pdo->rollBack();
            respondAdminInvitationPage("Invitation unavailable", "<p class=\"error\">This invitation is invalid, expired, or has already been answered.</p>", 410);
        }

        if ($action === "decline") {
            $update = $pdo->prepare("UPDATE admin_invitations SET status = 'declined', responded_at = NOW() WHERE id = ? AND status = 'pending'");
            $update->execute([$invitation["id"]]);
            if ($update->rowCount() !== 1) {
                throw new AdminInvitationException("This invitation has already been answered.", 409);
            }
            $pdo->commit();
            respondAdminInvitationPage("Invitation declined", "<p>You declined the administrator invitation. No admin access was granted.</p>");
        }

        $userStatement = $pdo->prepare("SELECT id, account_status FROM users WHERE email = ? LIMIT 1 FOR UPDATE");
        $userStatement->execute([$invitation["invited_email"]]);
        $existingUser = $userStatement->fetch(PDO::FETCH_ASSOC);
        if ($existingUser) {
            if ($existingUser["account_status"] !== "active") {
                throw new AdminInvitationException("This email belongs to an inactive account. Contact the barangay office.", 409);
            }
            $promote = $pdo->prepare("UPDATE users SET role = 'admin' WHERE id = ? AND account_status = 'active'");
            $promote->execute([$existingUser["id"]]);
        } else {
            $fullName = trim((string) preg_replace('/[\r\n\x00-\x1F\x7F]+/u', " ", (string) ($_POST["full_name"] ?? "")));
            $fullNameLength = preg_match_all('/./u', $fullName);
            $password = $_POST["password"] ?? "";
            $passwordConfirmation = $_POST["password_confirmation"] ?? "";
            if ($fullNameLength === false || $fullNameLength < 2 || $fullNameLength > 120) {
                throw new AdminInvitationException("Enter a full name between 2 and 120 characters.", 422);
            }
            if (!is_string($password) || strlen($password) < 12 || !is_string($passwordConfirmation) || !hash_equals($password, $passwordConfirmation)) {
                throw new AdminInvitationException("Enter a password of at least 12 characters and confirm it correctly.", 422);
            }
            $passwordHash = password_hash($password, PASSWORD_DEFAULT);
            if ($passwordHash === false) {
                throw new RuntimeException("Unable to secure the new administrator password.");
            }
            $createUser = $pdo->prepare("
                INSERT INTO users (full_name, email, password_hash, role, account_status)
                VALUES (?, ?, ?, 'admin', 'active')
            ");
            $createUser->execute([$fullName, $invitation["invited_email"], $passwordHash]);
        }

        $update = $pdo->prepare("UPDATE admin_invitations SET status = 'accepted', responded_at = NOW() WHERE id = ? AND status = 'pending'");
        $update->execute([$invitation["id"]]);
        if ($update->rowCount() !== 1) {
            throw new AdminInvitationException("This invitation has already been answered.", 409);
        }
        $pdo->commit();
        respondAdminInvitationPage("Invitation accepted", "<p>Your administrator access is active. You may now sign in to the barangay system.</p>");
    } catch (AdminInvitationException $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        respondAdminInvitationPage("Invitation not completed", "<p class=\"error\">" . escapeAdminInvitationHtml($error->getMessage()) . "</p>", $error->httpStatus);
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        error_log("Admin invitation decision failed: " . $error->getMessage());
        respondAdminInvitationPage("Invitation not completed", "<p class=\"error\">The invitation could not be completed. Please try again or contact the barangay office.</p>", 500);
    }
}

try {
    ensureAdminInvitationTable($pdo);
    $method = $_SERVER["REQUEST_METHOD"] ?? "GET";

    if ($method === "GET" && isset($_GET["token"])) {
        renderAdminInvitationTokenPage($pdo, trim((string) $_GET["token"]), trim((string) ($_GET["action"] ?? "")));
    }

    if ($method === "GET") {
        authenticateUser($pdo, ["admin"]);
        $statement = $pdo->query("
            SELECT id, invited_email AS email,
                CASE WHEN status = 'pending' AND expires_at <= NOW() THEN 'expired' ELSE status END AS status,
                created_at AS createdAt
            FROM admin_invitations
            ORDER BY created_at DESC, id DESC
            LIMIT 50
        ");
        respondAdminInvitationJson(200, ["success" => true, "data" => $statement->fetchAll(PDO::FETCH_ASSOC)]);
    }

    if ($method !== "POST") {
        header("Allow: GET, POST, OPTIONS");
        respondAdminInvitationJson(405, ["success" => false, "message" => "Method not allowed."]);
    }

    $contentType = strtolower((string) ($_SERVER["CONTENT_TYPE"] ?? ""));
    if (str_contains($contentType, "application/json")) {
        try {
            $input = json_decode(file_get_contents("php://input"), true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException $error) {
            respondAdminInvitationJson(400, ["success" => false, "message" => "The invitation request is invalid."]);
        }
        if (!is_array($input) || ($input["action"] ?? "") !== "invite") {
            respondAdminInvitationJson(400, ["success" => false, "message" => "A valid invitation action is required."]);
        }
        $admin = authenticateUser($pdo, ["admin"]);
        $email = strtolower(trim((string) ($input["email"] ?? "")));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 254) {
            respondAdminInvitationJson(422, ["success" => false, "message" => "Enter a valid email address."]);
        }

        $baseInvitationUrl = trim((string) getenv("BRGY_ADMIN_INVITATION_URL"));
        $invitationUrlConfigured = $baseInvitationUrl !== "";
        if (!$invitationUrlConfigured) {
            $scheme = (!empty($_SERVER["HTTPS"]) && strtolower((string) $_SERVER["HTTPS"]) !== "off")
                || strtolower((string) ($_SERVER["REQUEST_SCHEME"] ?? "")) === "https"
                ? "https"
                : "http";
            $serverName = trim((string) ($_SERVER["SERVER_NAME"] ?? ""));
            $scriptPath = (string) ($_SERVER["SCRIPT_NAME"] ?? "/admin-invitations.php");
            $port = filter_var($_SERVER["SERVER_PORT"] ?? null, FILTER_VALIDATE_INT);
            $bareHost = trim($serverName, "[]");
            $validHost = filter_var($bareHost, FILTER_VALIDATE_IP)
                || (bool) preg_match('/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*\.?$/i', $bareHost);
            if ($serverName === "" || !$validHost || $scriptPath === "" || $scriptPath[0] !== "/" || preg_match('/[\r\n?#]/', $scriptPath)) {
                respondAdminInvitationJson(503, ["success" => false, "message" => "The invitation link could not be built from this backend address."]);
            }
            $host = filter_var($bareHost, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) ? "[" . $bareHost . "]" : $bareHost;
            $defaultPort = $scheme === "https" ? 443 : 80;
            $portSuffix = $port && $port !== $defaultPort ? ":" . $port : "";
            $baseInvitationUrl = $scheme . "://" . $host . $portSuffix . $scriptPath;
        }
        $urlParts = $baseInvitationUrl !== "" ? parse_url($baseInvitationUrl) : false;
        if (!filter_var($baseInvitationUrl, FILTER_VALIDATE_URL)
            || !is_array($urlParts)
            || !in_array(strtolower($urlParts["scheme"] ?? ""), ["http", "https"], true)
            || empty($urlParts["host"])
            || isset($urlParts["user"])
            || isset($urlParts["pass"])
            || isset($urlParts["query"])
            || isset($urlParts["fragment"])) {
            respondAdminInvitationJson(503, ["success" => false, "message" => "BRGY_ADMIN_INVITATION_URL must be a valid admin-invitations.php URL without query parameters."]);
        }
        $invitationHost = strtolower(trim($urlParts["host"], "[]"));
        if (strtolower($urlParts["scheme"]) !== "https"
            && !in_array($invitationHost, ["localhost", "127.0.0.1", "::1"], true)) {
            respondAdminInvitationJson(503, ["success" => false, "message" => "Admin invitation links must use HTTPS outside localhost."]);
        }

        $account = $pdo->prepare("SELECT role, account_status FROM users WHERE email = ? LIMIT 1");
        $account->execute([$email]);
        $existingAccount = $account->fetch(PDO::FETCH_ASSOC);
        if ($existingAccount && $existingAccount["account_status"] !== "active") {
            respondAdminInvitationJson(409, ["success" => false, "message" => "This email belongs to an inactive system account."]);
        }
        if ($existingAccount && $existingAccount["role"] === "admin") {
            respondAdminInvitationJson(409, ["success" => false, "message" => "This email already belongs to an administrator."]);
        }

        $expireOld = $pdo->prepare("
            UPDATE admin_invitations SET status = 'expired'
            WHERE invited_email = ? AND status = 'pending' AND expires_at <= NOW()
        ");
        $expireOld->execute([$email]);
        $pending = $pdo->prepare("
            SELECT id FROM admin_invitations
            WHERE invited_email = ? AND status = 'pending' AND expires_at > NOW()
            LIMIT 1
        ");
        $pending->execute([$email]);
        if ($pending->fetch()) {
            respondAdminInvitationJson(409, ["success" => false, "message" => "An active invitation is already waiting for this email."]);
        }

        $token = bin2hex(random_bytes(32));
        $insert = $pdo->prepare("
            INSERT INTO admin_invitations (invited_email, token_hash, inviter_user_id, expires_at)
            VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))
        ");
        $insert->execute([$email, hash("sha256", $token), $admin["id"]]);
        $invitationId = (int) $pdo->lastInsertId();
        $invitationUrl = rtrim($baseInvitationUrl, "?&") . "?token=" . rawurlencode($token);

        try {
            sendAdminInvitationEmail($email, $invitationUrl);
        } catch (AdminInvitationException $error) {
            $expire = $pdo->prepare("UPDATE admin_invitations SET status = 'expired', responded_at = NOW() WHERE id = ? AND status = 'pending'");
            $expire->execute([$invitationId]);
            respondAdminInvitationJson($error->httpStatus, ["success" => false, "message" => $error->getMessage()]);
        }

        $created = $pdo->prepare("
            SELECT id, invited_email AS email, status, created_at AS createdAt
            FROM admin_invitations
            WHERE id = ?
            LIMIT 1
        ");
        $created->execute([$invitationId]);
        respondAdminInvitationJson(201, [
            "success" => true,
            "message" => "Invitation sent.",
            "invitationUrlConfigured" => $invitationUrlConfigured,
            "invitation" => $created->fetch(PDO::FETCH_ASSOC),
        ]);
    }

    if ($method === "POST") {
        handleAdminInvitationDecision(
            $pdo,
            trim((string) ($_POST["action"] ?? "")),
            trim((string) ($_POST["token"] ?? "")),
        );
    }
} catch (Throwable $error) {
    error_log("Admin invitation service error: " . $error->getMessage());
    respondAdminInvitationJson(500, ["success" => false, "message" => "The admin invitation service is unavailable."]);
}
