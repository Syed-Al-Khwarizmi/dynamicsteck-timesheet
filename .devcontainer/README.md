# Codespace

Node 22 and this project's dependencies, in a browser tab, with nothing on your
own machine.

    npm start

Port 3000 forwards automatically and a preview opens. The first boot prints an
administrator password in the terminal - copy it before it scrolls past.

## Creating the hosted database

Only needed once, when you are ready to deploy:

    curl -sSfL https://get.tur.so/install.sh | bash
    exec $SHELL
    turso auth login
    turso db create timesheet
    turso db show timesheet --url
    turso db tokens create timesheet

This is not part of the container setup on purpose - it would add a download to
every codespace start for something you run once.

## If creation is slow

The first create for a repository is the slowest; later starts resume a stopped
codespace and are much quicker. If it stalls, open **View creation log** from
the loading screen to see which step is running.

Stop the codespace from github.com/codespaces when you finish. Free accounts get
120 core hours a month and a running 2-core machine spends 2 an hour.
