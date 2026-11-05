echo "--- one business per database ---"
t "the business"               ok   "INSERT INTO Business (BusinessID,Name) VALUES ('B1','Cafe');"
t "a second business"          fail "INSERT INTO Business (BusinessID,Name) VALUES ('B2','Shop');"
t "the business can change"    ok   "UPDATE Business SET Name='Cafe & Bakery' WHERE BusinessID='B1';"
