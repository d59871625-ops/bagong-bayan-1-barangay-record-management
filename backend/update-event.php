<?php
require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

header("Content-Type: application/json; charset=utf-8");

if ($_SERVER["REQUEST_METHOD"] !== "PUT") {
    http_response_code(405);
    echo json_encode([
        "success" => false,
        "message" => "Method not allowed. Use PUT."
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

$id = filter_var($data["id"] ?? null, FILTER_VALIDATE_INT);
$title = trim($data["title"] ?? "");
$description = trim($data["description"] ?? "");
$eventDate = trim($data["event_date"] ?? "");
$startTime = trim($data["start_time"] ?? "");
$endTime = trim($data["end_time"] ?? "");
$location = trim($data["location"] ?? "");
$status = trim($data["status"] ?? "");

if (!$id || $id < 1) {
    http_response_code(422);
    echo json_encode([
        "success" => false,
        "message" => "A valid event ID is required."
    ]);
    exit;
}

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
    $check = $pdo->prepare("SELECT id FROM events WHERE id = ?");
    $check->execute([$id]);

    if (!$check->fetch()) {
        http_response_code(404);
        echo json_encode([
            "success" => false,
            "message" => "Event not found."
        ]);
        exit;
    }

    $stmt = $pdo->prepare("
        UPDATE events
        SET
            title = ?,
            description = ?,
            event_date = ?,
            start_time = ?,
            end_time = ?,
            location = ?,
            status = ?
        WHERE id = ?
    ");

    $stmt->execute([
        $title,
        $description !== "" ? $description : null,
        $eventDate,
        $startTime !== "" ? $startTime : null,
        $endTime !== "" ? $endTime : null,
        $location !== "" ? $location : null,
        $status,
        $id
    ]);

    echo json_encode([
        "success" => true,
        "message" => "Event updated successfully.",
        "data" => [
            "id" => (int) $id,
            "title" => $title,
            "description" => $description,
            "event_date" => $eventDate,
            "start_time" => $startTime ?: null,
            "end_time" => $endTime ?: null,
            "location" => $location ?: null,
            "status" => $status,
            "updated_by" => (int) $user["id"]
        ]
    ]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        "success" => false,
        "message" => "Failed to update event."
    ]);
}
