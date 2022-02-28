#!/bin/bash

GIT=`which git`
NPM=`which npm`

if [ -z "$GIT" ]; then
  echo "Please install git first: sudo apt install git"
  exit 1;
fi

if [ -z "$NPM" ]; then
  echo "Please install npm first: sudo apt install npm"
  exit 2;
fi

git clone https://github.com/RunOnFlux/nat-upnp.git
cd nat-upnp

npm i
npm run build
npm run flux-test

echo "**********************************"
echo "           Test Complete          "
echo "**********************************"
echo ""
echo "The tests can be re-run with the command:"
echo "npm run flux-test"
echo ""
echo "You can remove everything that was downloaded with:"
echo "rm -rf nat-upnp"
echo ""
