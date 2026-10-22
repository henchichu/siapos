USE miniworld;

INSERT INTO OrderChannel (ChannelCode, Description, Active)
VALUES (3, 'KIOSK', TRUE)
ON DUPLICATE KEY UPDATE Description = VALUES(Description), Active = VALUES(Active);