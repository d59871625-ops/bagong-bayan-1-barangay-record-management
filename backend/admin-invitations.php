<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");

http_response_code(410);
echo json_encode([
    "success" => false,
    "message" => "Admin invitations have been removed from this system.",
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
