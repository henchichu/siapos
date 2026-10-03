REVOKE ALL PRIVILEGES ON miniworld.* FROM 'app_user'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON miniworld.* TO 'app_user'@'%';
