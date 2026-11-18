<?php
require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

header("Content-Type: application/json; charset=utf-8");

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    http_response_code(405);
    echo json_encode([
        "success" => false,
        "message" => "Method not allowed. Use POST."
    ]);
    exit;
}

$user = authenticateUser($pdo, ["admin", "official"]);

$data = json_decode(file_get_contents("php://input"), true);

if (!is_array($data)) {
    http_response_code(400);
    echo json_encode([
        "success" => false,
        "message" => "Invalid JSON request."
    ]);
    exit;
}

$title = trim($data["title"] ?? "");
$description = trim($data["description"] ?? "");
$eventDate = trim($data["event_date"] ?? "");
$startTime = trim($data["start_time"] ?? "");
$endTime = trim($data["end_time"] ?? "");
$location = trim($data["location"] ?? "");
$status = trim($data["status"] ?? "planned");

if ($title === "" || mb_strlen($title) > 200) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "Event title is required and must not exceed 200 characters."
    ]);
    exit;
}

$dateObject = DateTime::createFromFormat("!Y-m-d", $eventDate);

if (!$dateObject || $dateObject->format("Y-m-d") !== $eventDate) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "A valid event date in YYYY-MM-DD format is required."
    ]);
    exit;
}

$validateTime = function ($time) {
    if ($time === "") {
        return true;
    }

    $date = DateTime::createFromFormat("!H:i", $time);

    return $date && $date->format("H:i") === $time;
};

if (!$validateTime($startTime) || !$validateTime($endTime)) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "Invalid time. Use HH:MM format."
    ]);
    exit;
}

if ($startTime !== "" && $endTime !== "" && $endTime <= $startTime) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "End time must be later than start time."
    ]);
    exit;
}

if (!in_array($status, ["planned", "completed", "cancelled"], true)) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "Invalid event status."
    ]);
    exit;
}

try {
    $stmt = $pdo->prepare("
        INSERT INTO events (
            title,
            description,
            event_date,
            start_time,
            end_time,
            location,
            status,
            created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ");

    $stmt->execute([
        $title,
        $description !== "" ? $description : null,
        $eventDate,
        $startTime !== "" ? $startTime : null,
        $endTime !== "" ? $endTime : null,
        $location !== "" ? $location : null,
        $status,
        $user["id"]
    ]);

    http_response_code(201);

    echo json_encode([
        "success" => true,
        "message" => "Event created successfully.",
        "data" => [
            "id" => (int) $pdo->lastInsertId(),
            "title" => $title,
            "description" => $description,
            "event_date" => $eventDate,
            "start_time" => $startTime ?: null,
            "end_time" => $endTime ?: null,
            "location" => $location ?: null,
            "status" => $status,
            "created_by" => (int) $user["id"]
        ]
    ]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Failed to create event."
    ]);
}
