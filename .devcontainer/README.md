# Codespace

Opening this repository in a Codespace gives you Node 22, the project's
dependencies, and the Turso CLI, with nothing installed on your own machine.

    npm start

Port 3000 is forwarded automatically and the preview opens. The first boot
prints an administrator password in the terminal - copy it before it scrolls.

To create the hosted database from here:

    turso auth login
    turso db create timesheet
    turso db show timesheet --url
    turso db tokens create timesheet

Stop the Codespace when you are done. Free accounts get 120 core hours a month,
and a running 2-core machine spends 2 of them an hour.
