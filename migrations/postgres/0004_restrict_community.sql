-- Legacy community imports remain restricted unless explicitly granted.
UPDATE listings SET visibility='restricted' WHERE source IN ('facebook','instagram');
