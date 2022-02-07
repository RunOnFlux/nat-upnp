#!/bin/bash

GIT=`which git`
NPM=`which npm`

[ -z "$GIT" ] && echo "Please install git first: sudo apt install git"
[ -z "$NPM" ] && echo "Please install npm first: sudo apt install npm"

if [ -z "$GIT" || -z "$NPM" ]; then
    exit 1;
fi

git clone https://github.com/RunOnFlux/node-nat-upnp.git
cd node-nat-upnp
git checkout flux-test

npm i
npm run flux-test

echo "**********************************"
echo "           Test Complete          "
echo "**********************************"
