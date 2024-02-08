import 'zx/globals'

const pkg = await fs.readJSON('./package.json')
pkg._enabledApiProposals = pkg.enabledApiProposals
pkg.displayName = "GenAIScript"
delete pkg.enabledApiProposals
await fs.writeJSON('./package.json', pkg, { spaces: 4 })
console.log(`cleaned package.json`)