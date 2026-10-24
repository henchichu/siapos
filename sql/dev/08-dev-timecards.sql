USE miniworld;

-- DEV ONLY. Timecard demo states on top of 05-dev-seed.sql.
-- The next pay period, so clocking in works after the seeded one has ended (there is no screen for creating pay periods yet)
INSERT INTO PayPeriod (PayPeriodID, BusinessID, StartDate, EndDate)
SELECT 'pp-next', BusinessID, EndDate + INTERVAL 1 DAY, EndDate + INTERVAL 14 DAY FROM PayPeriod WHERE PayPeriodID = 'pp-curr';

-- One approved and one rejected card among the submitted ones
UPDATE TimeEntry SET TimeEntryStatusCode = 3, ApprovedByEmployeeID = 'emp-leo' WHERE TimeEntryID = 'te-priya-02';
UPDATE TimeEntry SET TimeEntryStatusCode = 4 WHERE TimeEntryID = 'te-jordan-04';
