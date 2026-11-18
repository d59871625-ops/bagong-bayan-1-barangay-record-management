<?php

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

header("Content-Type: application/json");

function respond(int $status, array $data): void
{
    http_response_code($status);
    echo json_encode($data, JSON_PRETTY_PRINT);
    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "GET") {
    respond(405, [
        "success" => false,
        "message" => "Method not allowed."
    ]);
}

try {
    $user = authenticateUser($pdo, ["resident"]);

    $stmt = $pdo->prepare("
        SELECT id
        FROM residents
        WHERE user_id = ?
          AND record_status = 'active'
        LIMIT 1
    ");

    $stmt->execute([$user["id"]]);
    $resident = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$resident) {
        respond(404, [
            "success" => false,
            "message" => "Active resident profile not found."
        ]);
    }

    $residentId = (int) $resident["id"];

    // Count published announcements.
    $stmt = $pdo->query("
        SELECT COUNT(*)
        FROM announcements
        WHERE status = 'published'
    ");
    $totalAnnouncements = (int) $stmt->fetchColumn();

    // Get latest published announcements.
    $stmt = $pdo->query("
        SELECT id, title, content, published_at
        FROM announcements
        WHERE status = 'published'
        ORDER BY published_at DESC, id DESC
        LIMIT 5
    ");
    $announcements = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Count upcoming published events.
    $stmt = $pdo->query("
        SELECT COUNT(*)
        FROM events
        WHERE status = 'published'
          AND event_date >= CURDATE()
    ");
    $upcomingEventsCount = (int) $stmt->fetchColumn();

    // Get upcoming published events.
    $stmt = $pdo->query("
        SELECT id, title, description, event_date, location
        FROM events
        WHERE status = 'published'
          AND event_date >= CURDATE()
        ORDER BY event_date ASC
        LIMIT 5
    ");
    $events = $stmt->fetchAll(PDO::FETCH_ASSOC);

    // Count this resident's document requests.
    $stmt = $pdo->prepare("
        SELECT COUNT(*)
        FROM document_requests
        WHERE resident_id = ?
    ");
    $stmt->execute([$residentId]);
    $totalDocumentRequests = (int) $stmt->fetchColumn();

    // Count pending document requests.
    $stmt = $pdo->prepare("
        SELECT COUNT(*)
        FROM document_requests
        WHERE resident_id = ?
          AND status = 'pending'
    ");
    $stmt->execute([$residentId]);
    $pendingDocumentRequests = (int) $stmt->fetchColumn();

    // Get latest document requests.
    $stmt = $pdo->prepare("
        SELECT id, document_type, purpose, status, remarks, created_at
        FROM document_requests
        WHERE resident_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 5
    ");
    $stmt->execute([$residentId]);
    $documentRequests = $stmt->fetchAll(PDO::FETCH_ASSOC);

    respond(200, [
        "success" => true,
        "message" => "Resident dashboard retrieved successfully.",
        "data" => [
            "summary" => [
                "total_announcements" => $totalAnnouncements,
                "upcoming_events" => $upcomingEventsCount,
                "total_document_requests" => $totalDocumentRequests,
                "pending_document_requests" => $pendingDocumentRequests
            ],
            "latest_announcements" => $announcements,
            "upcoming_events" => $events,
            "recent_document_requests" => $documentRequests
        ]
    ]);

} catch (Throwable $e) {
    error_log("Resident dashboard error: " . $e->getMessage());

    respond(500, [
        "success" => false,
        "message" => "An internal server error occurred."
    ]);
}