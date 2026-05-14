       IDENTIFICATION DIVISION.
       PROGRAM-ID. BRNCH01.

       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-ACCOUNTS.
          05 WS-ACCOUNTS-TABLE.
             10 WS-ACCOUNT OCCURS 4 TIMES.
                15 WS-STATUS        PIC X(1) VALUE SPACE.
                15 WS-AMOUNT        PIC S9(5)V99 VALUE 0.
       01 WS-INDEX             PIC 99 VALUE 1.
       01 WS-APPROVED          PIC 9 VALUE 0.
       01 WS-REJECTED          PIC 9 VALUE 0.

       PROCEDURE DIVISION.
           MOVE "A" TO WS-STATUS (1)
           MOVE 130.00 TO WS-AMOUNT (1)
           MOVE "R" TO WS-STATUS (2)
           MOVE  45.10 TO WS-AMOUNT (2)
           MOVE "A" TO WS-STATUS (3)
           MOVE 200.00 TO WS-AMOUNT (3)
           MOVE "R" TO WS-STATUS (4)
           MOVE  70.00 TO WS-AMOUNT (4)

           PERFORM VARYING WS-INDEX FROM 1 BY 1 UNTIL WS-INDEX > 4
             EVALUATE WS-STATUS (WS-INDEX)
               WHEN "A"
                 ADD 1 TO WS-APPROVED
               WHEN OTHER
                 ADD 1 TO WS-REJECTED
             END-EVALUATE
           END-PERFORM

           IF WS-APPROVED >= WS-REJECTED
               DISPLAY "APPROVED-COUNT=" WS-APPROVED
               DISPLAY "REJECTED-COUNT=" WS-REJECTED
           ELSE
               DISPLAY "REJECTED-WINS"
           END-IF

           STOP RUN.
