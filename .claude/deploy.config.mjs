// This project's additions to the /deploy skill, which builds a branch's committed files in a temp folder
// and copies the build into the live folder. The skill is shared between projects, so this file names
// this one's folder among the machine's live folders, which git config deploy.liveRoot says where to find.
//
// The build uses relative asset paths, so it runs from any folder, and this is the only place that names it.
export default {
  liveName: 'pdbsplat',
}
