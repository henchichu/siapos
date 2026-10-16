USE miniworld;

-- DEV ONLY. One script for sign-in secrets; add passwords here too.
-- Hash format: scrypt$<salt hex>$<hash hex> (N=16384, r=8, p=1, 64-byte key), same as server/auth.js.
-- Dev PINs (6 digits):   Maya 111111, Leo 222222, Sam 333333, Priya 444444, Jordan 555555
-- Dev passwords:         <first name lowercase>-dev-pass
INSERT INTO EmployeeCredential (EmployeeID, PasswordHash, PinHash)
VALUES
    ('emp-maya', 'scrypt$96dbbda139e6a4fb10b55fe8592f1f76$a1d9005c90c21486fa291004c0a9c08defd52db6522f83ce674c72c65ecb938f8ff93444473230e0e96fee11fe94af5092ae9883159ed39787e18bc899bedbb4', 'scrypt$e21c07e979f2c44a4a4db68a409096be$536d52544c5a3318264553c6ed84681a361ef323ef8c152bb77c04eccc18c0345d3a58ebe598220491a2c135fef3fae31245083f073feada304a9fa6b3412dac'),
    ('emp-leo', 'scrypt$fe180e6248f48817cc254a1c666f18f4$23dfd86480c1c73dc2b3543cbdab152fb0e7d3f0ef6e85cc9befec933d49842d0518da3c18460117141c621db71462db46be2622debddb158a244a8faef3fd8e', 'scrypt$64d6acea2c850156fdbcef9cfa15d5e1$7815b9b72f415012454be324434da0e82a1a500d227d9385e9ff07475409e54588378caed52bc5b1f379a58487b07e0a367da8b1191e5b4fb53c752fa65f10ae'),
    ('emp-sam', 'scrypt$df7b27afd714fd97c5918dc54aa54228$a6f46d3bfc17aacc88ce73d52b23f3c7d185921a639230cd69f6488946293ee9252d3696231c60cc4af08ba7de0285ea2110ae21856944c7c6059102dd5f5a8f', 'scrypt$fee1ef33f9a3c71cca1a59b819e21591$fbe08c92135242b0244cc2d137b535ab5eb2a4ba55d1897f066136094061ee4e58c765c0696bc95b4626515dd6fcc7b9c4f9d960d81c6cad31357e54315f0467'),
    ('emp-priya', 'scrypt$dcbbfb257dd9f23ba72cdd722084d608$63ab40b1142cfb7c3b331288d226589073699beab44f0ecb1537533688d4c0297fd76872440a636c49a906ac0f01f8228d2ed1d7ad08f841f4b4db5438668263', 'scrypt$392aba76ba6d534d653837d7570ce320$3f919beaf5ba325300b881f54a7e32e076729eacf78670867508923d3527553e442d696a49b91b228657c8c5e5a88ecef92b7a597d2b40cd4ba6d10dfa84a1f4'),
    ('emp-jordan', 'scrypt$849df5676da49c9b515995e94a0b73c3$4aeed45b2688b142b2e2fa4ed94afacfb294ef2283c07db61deed382b0302786a5ce9714585081e88ac07990b186d61333ee83b8ff75157cf605a8a808d2b53e', 'scrypt$1f241769b564a232d4e23a139cf679b9$bc3be5fb72bc40c28007b4096924d82dba4fa0fd3f180aa1764f16ef4817023a58ea141ab3383735d80d0bfc2c4a735ecbb0ad92f76fcd14f6b9c872d1c63cb5')
ON DUPLICATE KEY UPDATE
    PasswordHash = VALUES(PasswordHash),
    PinHash = VALUES(PinHash),
    FailedPinAttempts = 0,
    LockedUntil = NULL;
