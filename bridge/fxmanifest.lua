-- testbed-bridge: test operations for fivem-testbed. Development servers only.
fx_version 'cerulean'
game 'gta5'

name 'testbed-bridge'
author 'fivem-testbed'
description 'Runs test operations for fivem-testbed. Keep testbed_enabled false on a production server.'
version '0.1.0'

server_script 'server.js'
client_script 'client.js'

ui_page 'ui/index.html'

files {
    'ui/index.html',
}
