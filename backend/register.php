<?php

header("Content-Type: application/json; charset=UTF-8");

require_once __DIR__ . "/db.php";

function respond($statusCode, $message, $data = null) {
    http_response_code($statusCode);

    echo json_encode([
        "success" => $statusCode >= 200 && $statusCode < 300,
        "message" => $message,
        "data" => $data
    ]);

    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    respond(405, "Only POST requests are allowed.");
}

$input = json_decode(file_get_contents("php://input"), true);

if (!is_array($input)) {
    respond(400, "Invalid JSON request.");
}

$firstName = trim($input["first_name"] ?? "");
$lastName = trim($input["last_name"] ?? "");
$email = strtolower(trim($input["email"] ?? ""));
$password = $input["password"] ?? "";

if ($firstName === "" || $lastName === "" || $email === "" || $password === "") {
    respond(422, "First name, last name, email, and password are required.");
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    respond(422, "Please provide a valid email address.");
}

if (strlen($password) < 8) {
    respond(422, "Password must be at least 8 characters.");
}

try {
    $checkUser = $pdo->prepare(
        "SELECT id FROM users WHERE email = ? LIMIT 1"
    );
    $checkUser->execute([$email]);

    if ($checkUser->fetch()) {
        respond(409, "An account with this email already exists.");
    }

    $checkRequest = $pdo->prepare(
        "SELECT id FROM registration_requests
         WHERE email = ? AND status = 'pending'
         LIMIT 1"
    );
    $checkRequest->execute([$email]);

    if ($checkRequest->fetch()) {
        respond(409, "A registration request with this email is already pending.");
    }

    $passwordHash = password_hash($password, PASSWORD_DEFAULT);

    $sql = "INSERT INTO registration_requests (
        first_name,
        middle_name,
        last_name,
        suffix,
        email,
        password_hash,
        date_of_birth,
        sex,
        civil_status,
        contact_number,
        house_no_street,
        purok,
        barangay,
        city_municipality,
        province
    ) VALUES (
        :first_name,
        :middle_name,
        :last_name,
        :suffix,
        :email,
        :password_hash,
        :date_of_birth,
        :sex,
        :civil_status,
        :contact_number,
        :house_no_street,
        :purok,
        :barangay,
        :city_municipality,
        :province
    )";

    $statement = $pdo->prepare($sql);

    $statement->execute([
        ":first_name" => $firstName,
        ":middle_name" => trim($input["middle_name"] ?? "") ?: null,
        ":last_name" => $lastName,
        ":suffix" => trim($input["suffix"] ?? "") ?: null,
        ":email" => $email,
        ":password_hash" => $passwordHash,
        ":date_of_birth" => $input["date_of_birth"] ?? null,
        ":sex" => $input["sex"] ?? null,
        ":civil_status" => $input["civil_status"] ?? null,
        ":contact_number" => $input["contact_number"] ?? null,
        ":house_no_street" => $input["house_no_street"] ?? null,
        ":purok" => $input["purok"] ?? null,
        ":barangay" => $input["barangay"] ?? null,
        ":city_municipality" => $input["city_municipality"] ?? null,
        ":province" => $input["province"] ?? null
    ]);

    respond(201, "Registration submitted successfully. Your application is pending approval.", [
        "registration_id" => $pdo->lastInsertId(),
        "status" => "pending"
    ]);

} catch (PDOException $e) {
    error_log($e->getMessage());
    respond(500, "Unable to submit registration. Please try again.");
}
